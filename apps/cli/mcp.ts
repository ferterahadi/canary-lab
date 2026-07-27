import { Readable, Writable } from 'stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runAsScript } from './run-as-script'
import { refreshAgentIntegrationsQuietly } from './agent'
import {
  DEFAULT_CANARY_LAB_MCP_PROFILE,
  normalizeCanaryLabMcpProfile,
  type CanaryLabMcpProfile,
} from '../web-server/src/mcp/tools'
import { isClientKind, type ClientKind } from '../../shared/run-mode'
import { type CanaryLabWorkspaceRegistry } from '../../shared/runtime/workspace-registry'
import {
  resolveActiveServer,
  type ActiveServerEntry,
} from '../../shared/runtime/active-servers'
import { DEFAULT_PORT, loadProjectConfig, resolveProjectPort } from '../web-server/src/features/runs/logic/runtime/launcher/project-config'
import { BridgeTransport, bridge, requiredToolsForProfile } from './mcp-bridge'
import { inferMcpClientKind } from './mcp-client-kind'
import { ensureMcpServerReachable, healthUrlFor, resolveUiProjectRootForMcpAutostart, urlWithContext } from './mcp-reachability'

export { REINIT_ID, bridge } from './mcp-bridge'
export type { BridgeTransport } from './mcp-bridge'
export { inferClientKindFromProcessLines, inferMcpClientKind } from './mcp-client-kind'
export { ensureMcpServerReachable, resolveUiProjectRootForMcpAutostart } from './mcp-reachability'

// Resolve the bridge's target /mcp URL with no explicit --url. A *live* server
// (recorded in ~/.canary-lab/active-servers.json by `canary-lab ui`) always
// wins, so the bridge follows whatever port the running UI actually bound —
// even after the user switched it. Only when nothing is running do we fall back
// to the most-recent workspace's configured port (which auto-start will boot).
export function resolveDefaultMcpUrl(opts: {
  cwd?: string
  homeDir?: string
  registry?: CanaryLabWorkspaceRegistry
  activeServers?: ActiveServerEntry[]
} = {}): string {
  const live = resolveActiveServer({
    homeDir: opts.homeDir,
    cwd: opts.cwd,
    ...(opts.activeServers ? { servers: opts.activeServers } : {}),
  })
  if (live) return `http://127.0.0.1:${live.port}/mcp`
  const projectRoot = resolveUiProjectRootForMcpAutostart(opts)
  const port = projectRoot ? resolveProjectPort(loadProjectConfig(projectRoot)) : DEFAULT_PORT
  return `http://127.0.0.1:${port}/mcp`
}

export const DEFAULT_MCP_PROFILE: CanaryLabMcpProfile = DEFAULT_CANARY_LAB_MCP_PROFILE

export interface McpCommandOptions {
  profile?: CanaryLabMcpProfile
  clientKind?: ClientKind
  stdin?: Readable
  stdout?: Writable
  stderr?: Writable
  fetch?: typeof fetch
  exit?: (code: number) => void
  autoStartUi?: boolean
  // True when the URL was auto-resolved (no explicit --url), so auto-starting
  // the active project's UI is appropriate. Defaults to the local-URL heuristic.
  autoStartEligible?: boolean
  startUi?: (stderr: Writable, projectRoot: string) => Promise<void> | void
  startupTimeoutMs?: number
  startupPollMs?: number
  cwd?: string
  homeDir?: string
  registry?: CanaryLabWorkspaceRegistry
  // Brings the installed agent skill up to date with this package version
  // before serving the bridge. Injected in tests so they never touch the real
  // home dir.
  refreshAgents?: () => void
  // Bridge transport seams + reconnect tuning. Injected in tests to drive the
  // reconnect loop deterministically without real stdio/HTTP transports.
  createHttpTransport?: (url: string) => BridgeTransport
  createStdioTransport?: () => BridgeTransport
  // Re-resolves the HTTP target when reconnecting (default re-reads the
  // live-server record so a switched port is followed automatically).
  reResolveUrl?: () => string
  reconnectAttempts?: number
  reconnectDelayMs?: number
}

export async function main(
  argv: string[] = process.argv.slice(2),
  opts: McpCommandOptions = {},
): Promise<void> {
  const exit = opts.exit ?? ((code: number) => { process.exit(code) })
  const stderr = opts.stderr ?? process.stderr
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    stderr.write(`${parsed.error}\n`)
    exit(1)
    return
  }
  const url = parsed.url ?? resolveDefaultMcpUrl({ cwd: opts.cwd, homeDir: opts.homeDir, registry: opts.registry })
  // Only auto-start the UI when we resolved the default URL ourselves; an
  // explicit --url means the caller is pointing at a specific server.
  const autoStartEligible = opts.autoStartEligible ?? (parsed.url === undefined)
  if (parsed.command === 'doctor') {
    const ok = await doctor(url, {
      ...opts,
      profile: parsed.profile,
      clientKind: parsed.clientKind ?? opts.clientKind,
      autoStartUi: opts.autoStartUi ?? parsed.autoStartUi,
      autoStartEligible,
    })
    exit(ok ? 0 : 1)
    return
  }
  // Refresh the installed agent skill to match this package before serving, so
  // external clients launching via `npx canary-lab mcp` always pick up current
  // behavior. Diagnostics-only `doctor` is exempt. Logs route to stderr —
  // stdout is the JSON-RPC channel to the client.
  const refreshAgents = opts.refreshAgents
    ?? (() => { refreshAgentIntegrationsQuietly({ homeDir: opts.homeDir, log: (m) => stderr.write(`${m}\n`) }) })
  refreshAgents()
  const ok = await bridge(url, {
    ...opts,
    profile: parsed.profile,
    clientKind: parsed.clientKind ?? opts.clientKind,
    autoStartUi: opts.autoStartUi ?? parsed.autoStartUi,
    autoStartEligible,
  })
  if (!ok) exit(1)
}

export async function doctor(url: string, opts: McpCommandOptions = {}): Promise<boolean> {
  const stderr = opts.stderr ?? process.stderr
  const stdout = opts.stdout ?? process.stdout
  const fetchFn = opts.fetch ?? fetch
  const profile = opts.profile ?? DEFAULT_MCP_PROFILE
  const profileUrl = urlWithContext(url, profile, opts.clientKind ?? inferMcpClientKind() ?? 'other')
  if (!await ensureMcpServerReachable(url, opts)) return false
  try {
    const healthUrl = healthUrlFor(profileUrl)
    const health = await fetchFn(healthUrl)
    if (!health.ok) throw new Error(`/mcp/health returned ${health.status}`)
    const healthBody = await health.json() as { toolCount?: number }

    const client = new Client(
      { name: 'canary-lab-mcp-doctor', version: '0.0.1' },
      { capabilities: {} },
    )
    const transport = new StreamableHTTPClientTransport(new URL(profileUrl), { fetch: fetchFn })
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      const names = tools.tools.map((tool) => tool.name)
      for (const required of requiredToolsForProfile(profile)) {
        if (!names.includes(required)) {
          throw new Error(`${required} is missing from tools/list`)
        }
      }
      stdout.write(`Canary Lab MCP is reachable at ${url}\n`)
      stdout.write(`Profile: ${profile}\n`)
      stdout.write(`Required tools: ${requiredToolsForProfile(profile).join(', ')}\n`)
      stdout.write(`Tools: ${names.length} listed (${healthBody.toolCount ?? 'unknown'} registered)\n`)
      return true
    } finally {
      await client.close().catch(() => undefined)
    }
  } catch (err) {
    stderr.write(`Canary Lab MCP doctor failed: ${(err as Error).message}\n`)
    stderr.write(`Start the UI first: canary-lab ui\n`)
    return false
  }
}

// Port-agnostic: any localhost /mcp endpoint is treated as the auto-resolved
// local server (auto-start eligible), since the port is now per-project.
export function isDefaultLocalMcpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      parsed.pathname === '/mcp'
  } catch {
    return false
  }
}

export function stripProfile(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('profile')
    return parsed.toString()
  } catch {
    return url
  }
}

function parseArgs(argv: string[]):
  | { ok: true; command: 'bridge' | 'doctor'; url?: string; profile: CanaryLabMcpProfile; clientKind?: ClientKind; autoStartUi: boolean }
  | { ok: false; error: string } {
  let command: 'bridge' | 'doctor' = 'bridge'
  // Undefined → resolve the active project's port via resolveDefaultMcpUrl.
  let url: string | undefined
  let profile: CanaryLabMcpProfile = DEFAULT_MCP_PROFILE
  let clientKind: ClientKind | undefined
  let autoStartUi = true
  const args = [...argv]
  if (args[0] === 'doctor') {
    command = 'doctor'
    args.shift()
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--no-autostart') {
      autoStartUi = false
      continue
    }
    if (arg === '--url') {
      const value = args[i + 1]
      if (!value) return { ok: false, error: 'Usage: canary-lab mcp [doctor] [--url <url>]' }
      url = value
      i += 1
      continue
    }
    if (arg === '--profile') {
      const value = args[i + 1]
      const parsedProfile = normalizeCanaryLabMcpProfile(value)
      if (!value || !parsedProfile) return { ok: false, error: `Invalid MCP profile: ${value ?? ''}` }
      profile = parsedProfile
      i += 1
      continue
    }
    if (arg === '--client-kind') {
      const value = args[i + 1]
      if (!isClientKind(value)) {
        return { ok: false, error: `Invalid MCP client kind: ${value ?? ''}` }
      }
      clientKind = value
      i += 1
      continue
    }
    return { ok: false, error: `Unknown canary-lab mcp argument: ${arg}` }
  }
  if (url !== undefined) {
    try {
      // Validate early so stdio mode fails before protocol output starts.
      new URL(url)
    } catch {
      return { ok: false, error: `Invalid MCP URL: ${url}` }
    }
  }
  return { ok: true, command, profile, autoStartUi, ...(url ? { url } : {}), ...(clientKind ? { clientKind } : {}) }
}

runAsScript(module, main)
