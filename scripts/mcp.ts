#!/usr/bin/env node

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawn } from 'child_process'
import { Readable, Writable } from 'stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { runAsScript } from './run-as-script'
import { refreshAgentIntegrationsQuietly } from './agent'
import {
  normalizeCanaryLabMcpProfile,
  type CanaryLabMcpProfile,
} from '../apps/web-server/mcp/tools'
import type { ExternalHealClientKind } from '../apps/web-server/lib/runtime/manifest'
import { looksLikeProjectRoot } from '../shared/runtime/project-root'
import {
  canaryLabHome,
  readWorkspaceRegistry,
  type CanaryLabWorkspaceRegistry,
} from '../shared/runtime/workspace-registry'
import {
  resolveActiveServer,
  type ActiveServerEntry,
} from '../shared/runtime/active-servers'
import { DEFAULT_PORT, loadProjectConfig, resolveProjectPort } from '../apps/web-server/lib/runtime/launcher/project-config'

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
const DEFAULT_MCP_PROFILE: CanaryLabMcpProfile = 'full'
const DEFAULT_UI_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_UI_STARTUP_POLL_MS = 250

export interface McpCommandOptions {
  profile?: CanaryLabMcpProfile
  clientKind?: ExternalHealClientKind
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

// Structural transport shape shared by the SDK's stdio + streamable-HTTP
// transports — just enough for the bridge to forward and reconnect.
export interface BridgeTransport {
  start(): Promise<void>
  send(message: JSONRPCMessage): Promise<void>
  close(): Promise<void>
  onmessage?: (message: JSONRPCMessage) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  setProtocolVersion?: (version: string) => void
}

// Sentinel id for the bridge's internal re-initialize handshake on reconnect.
// Its response is swallowed so the client never sees a second initialize reply.
export const REINIT_ID = '__canary-lab-reinit__'

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

export async function bridge(url: string, opts: McpCommandOptions = {}): Promise<boolean> {
  const stderr = opts.stderr ?? process.stderr
  const fetchFn = opts.fetch ?? fetch
  const profile = opts.profile ?? DEFAULT_MCP_PROFILE
  const clientKind = opts.clientKind ?? inferMcpClientKind() ?? 'other'
  const initialUrl = urlWithContext(url, profile, clientKind)
  if (!await ensureMcpServerReachable(initialUrl, opts)) return false

  const createHttp = opts.createHttpTransport
    ?? ((target: string) =>
      new StreamableHTTPClientTransport(new URL(target), { fetch: fetchFn }) as unknown as BridgeTransport)
  const stdio: BridgeTransport = opts.createStdioTransport
    ? opts.createStdioTransport()
    : (new StdioServerTransport(opts.stdin, opts.stdout) as unknown as BridgeTransport)

  // When reconnecting, re-resolve the target. An explicit --url pins the same
  // server; otherwise re-read the live-server record so a switched port (or
  // relaunched UI) is followed without restarting the client.
  const reResolveUrl = opts.reResolveUrl
    ?? (opts.autoStartEligible === false
      ? () => initialUrl
      : () => urlWithContext(
          resolveDefaultMcpUrl({ cwd: opts.cwd, homeDir: opts.homeDir, registry: opts.registry }),
          profile,
          clientKind,
        ))
  const reconnectAttempts = opts.reconnectAttempts ?? 120
  const reconnectDelayMs = opts.reconnectDelayMs ?? 500

  let http = createHttp(initialUrl)
  let cachedInitialize: JSONRPCMessage | null = null
  let stdioClosing = false
  let reconnecting = false

  const wireHttp = (transport: BridgeTransport): void => {
    transport.onmessage = (message) => {
      // The client already initialized against the previous server; drop the
      // reply to our internal re-initialize so it never sees a duplicate.
      if (isResponseTo(message, REINIT_ID)) return
      if (isInitializeResult(message)) transport.setProtocolVersion?.(message.result.protocolVersion)
      forwardMessage(stdio, message).catch((err) => transport.onerror?.(err as Error))
    }
    transport.onclose = () => { void reconnect('UI server connection closed') }
    transport.onerror = (err) => { stderr.write(`Canary Lab MCP HTTP error: ${err.message}\n`) }
  }

  const reinitialize = async (transport: BridgeTransport): Promise<void> => {
    const params = (cachedInitialize as { params?: unknown } | null)?.params
    await transport.send({ jsonrpc: '2.0', id: REINIT_ID, method: 'initialize', params } as JSONRPCMessage)
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage)
  }

  const reconnect = async (reason: string): Promise<void> => {
    if (stdioClosing || reconnecting) return
    reconnecting = true
    stderr.write(`Canary Lab MCP lost the UI server (${reason}); reconnecting…\n`)
    try { await http.close() } catch { /* already closed */ }
    for (let attempt = 0; attempt < reconnectAttempts && !stdioClosing; attempt += 1) {
      const target = reResolveUrl()
      if ((await checkHealth(target, fetchFn)).ok) {
        const next = createHttp(target)
        wireHttp(next)
        try {
          await next.start()
          if (cachedInitialize) await reinitialize(next)
          // Tell the client to re-list tools against the new server.
          await forwardMessage(stdio, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as JSONRPCMessage)
          http = next
          reconnecting = false
          stderr.write(`Canary Lab MCP reconnected at ${stripProfile(target)}\n`)
          return
        } catch (err) {
          stderr.write(`Canary Lab MCP reconnect attempt failed: ${(err as Error).message}\n`)
          try { await next.close() } catch { /* ignore */ }
        }
      }
      await sleep(reconnectDelayMs)
    }
    // Out of attempts: stay idle. The next client message retriggers reconnect.
    reconnecting = false
  }

  stdio.onmessage = (message) => {
    if (isInitializeRequest(message)) cachedInitialize = message
    forwardMessage(http, message).catch((err) => {
      stdio.onerror?.(err as Error)
      void reconnect('forwarding to UI server failed')
    })
  }
  stdio.onclose = () => {
    stdioClosing = true
    void stdio.close().catch(() => undefined)
    void http.close().catch(() => undefined)
  }
  stdio.onerror = (err) => stderr.write(`Canary Lab MCP stdio error: ${err.message}\n`)

  wireHttp(http)
  await http.start()
  await stdio.start()
  return true
}

export async function ensureMcpServerReachable(
  url: string,
  opts: McpCommandOptions = {},
): Promise<boolean> {
  const stderr = opts.stderr ?? process.stderr
  const fetchFn = opts.fetch ?? fetch
  const eligible = opts.autoStartEligible ?? isDefaultLocalMcpUrl(url)
  const firstCheck = await checkHealth(url, fetchFn)
  if (firstCheck.ok) {
    if (
      eligible &&
      firstCheck.projectRoot &&
      !isUsableUiProjectRoot(firstCheck.projectRoot)
    ) {
      stderr.write(`Canary Lab MCP is reachable at ${stripProfile(url)} but is serving unusable projectRoot "${firstCheck.projectRoot}". Stop that server, then run \`canary-lab ui\` from a Canary Lab workspace.\n`)
      return false
    }
    return true
  }

  if (opts.autoStartUi === false || !eligible) {
    stderr.write(`Canary Lab MCP is not reachable at ${stripProfile(url)}: ${firstCheck.error}\n`)
    stderr.write('Start the UI first: canary-lab ui\n')
    return false
  }

  stderr.write('Canary Lab UI is not running; starting `canary-lab ui --no-open`...\n')
  const projectRoot = resolveUiProjectRootForMcpAutostart({
    cwd: opts.cwd ?? process.cwd(),
    homeDir: opts.homeDir,
    registry: opts.registry,
  })
  if (!projectRoot) {
    stderr.write('Cannot auto-start Canary Lab UI because no workspace could be resolved. Run `canary-lab ui` from a Canary Lab workspace, or set CANARY_LAB_PROJECT_ROOT.\n')
    return false
  }
  try {
    await (opts.startUi ?? startUiInBackground)(stderr, projectRoot)
  } catch (err) {
    stderr.write(`Failed to start Canary Lab UI: ${(err as Error).message}\n`)
    stderr.write('Start the UI manually: canary-lab ui\n')
    return false
  }

  const timeoutMs = opts.startupTimeoutMs ?? DEFAULT_UI_STARTUP_TIMEOUT_MS
  const pollMs = opts.startupPollMs ?? DEFAULT_UI_STARTUP_POLL_MS
  const deadline = Date.now() + timeoutMs
  let lastError = firstCheck.error
  while (Date.now() <= deadline) {
    await sleep(pollMs)
    const check = await checkHealth(url, fetchFn)
    if (check.ok) return true
    lastError = check.error
  }

  stderr.write(`Canary Lab MCP is not reachable at ${stripProfile(url)} after starting the UI: ${lastError}\n`)
  stderr.write('Start the UI manually: canary-lab ui\n')
  return false
}

async function checkHealth(
  url: string,
  fetchFn: typeof fetch,
): Promise<{ ok: true; projectRoot?: string } | { ok: false; error: string }> {
  try {
    const health = await fetchFn(healthUrlFor(url))
    if (!health.ok) return { ok: false, error: `/mcp/health returned ${health.status}` }
    const body = await health.json().catch(() => null) as { projectRoot?: unknown } | null
    return {
      ok: true,
      ...(typeof body?.projectRoot === 'string' ? { projectRoot: body.projectRoot } : {}),
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

function startUiInBackground(stderr: Writable, projectRoot: string): void {
  const child = spawn(process.execPath, [resolveCliPath(), 'ui', '--no-open'], {
    cwd: projectRoot,
    detached: true,
    env: { ...process.env, CANARY_LAB_PROJECT_ROOT: projectRoot },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr.write(`[canary-lab ui] ${chunk.toString()}`)
  })
  child.unref()
}

export function resolveUiProjectRootForMcpAutostart(opts: {
  cwd?: string
  homeDir?: string
  registry?: CanaryLabWorkspaceRegistry
} = {}): string | null {
  const explicitRoot = process.env.CANARY_LAB_PROJECT_ROOT
  if (explicitRoot && isUsableUiProjectRoot(explicitRoot)) {
    return path.resolve(explicitRoot)
  }

  const cwd = path.resolve(opts.cwd ?? process.cwd())
  const fromCwd = findUsableUiProjectRootUpward(cwd)
  if (fromCwd) return fromCwd

  const registry = opts.registry ?? readWorkspaceRegistry(opts.homeDir ?? canaryLabHome())
  const candidates = registry.workspaces
    .filter((workspace) => isUsableUiProjectRoot(workspace.path))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return candidates[0]?.path ?? null
}

function findUsableUiProjectRootUpward(start: string): string | null {
  let current = path.resolve(start)
  while (true) {
    if (isUsableUiProjectRoot(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function isUsableUiProjectRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate)
  return looksLikeProjectRoot(resolved) || looksLikeCanaryLabPackage(resolved)
}

function looksLikeCanaryLabPackage(candidate: string): boolean {
  const packageJson = path.join(candidate, 'package.json')
  if (!fs.existsSync(packageJson)) return false
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf-8')) as { name?: string }
    return parsed.name === 'canary-lab'
  } catch {
    return false
  }
}

function resolveCliPath(): string {
  const siblingCli = path.join(__dirname, 'cli.js')
  if (fs.existsSync(siblingCli)) return siblingCli
  return process.argv[1] ?? siblingCli
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

function stripProfile(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('profile')
    return parsed.toString()
  } catch {
    return url
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(argv: string[]):
  | { ok: true; command: 'bridge' | 'doctor'; url?: string; profile: CanaryLabMcpProfile; clientKind?: ExternalHealClientKind; autoStartUi: boolean }
  | { ok: false; error: string } {
  let command: 'bridge' | 'doctor' = 'bridge'
  // Undefined → resolve the active project's port via resolveDefaultMcpUrl.
  let url: string | undefined
  let profile: CanaryLabMcpProfile = DEFAULT_MCP_PROFILE
  let clientKind: ExternalHealClientKind | undefined
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
      if (!isExternalHealClientKind(value)) {
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

async function forwardMessage(
  transport: { send(message: JSONRPCMessage): Promise<void> },
  message: JSONRPCMessage,
): Promise<void> {
  await transport.send(message)
}

function healthUrlFor(url: string): string {
  const parsed = new URL(url)
  parsed.pathname = parsed.pathname.replace(/\/?$/, '/health')
  parsed.hash = ''
  return parsed.toString()
}

function urlWithContext(
  url: string,
  profile: CanaryLabMcpProfile,
  clientKind: ExternalHealClientKind,
): string {
  const parsed = new URL(url)
  parsed.searchParams.set('profile', profile)
  parsed.searchParams.set('client_kind', clientKind)
  return parsed.toString()
}

function requiredToolsForProfile(profile: CanaryLabMcpProfile): string[] {
  if (profile === 'author') return ['create_feature', 'start_external_draft', 'start_external_evaluation_export']
  if (profile === 'verify') return ['execute_verification']
  if (profile === 'full') return ['wait_for_heal_task', 'start_external_evaluation_export', 'execute_verification']
  return ['wait_for_heal_task']
}

function isInitializeResult(message: JSONRPCMessage): message is JSONRPCMessage & {
  result: { protocolVersion: string }
} {
  return 'result' in message &&
    !!message.result &&
    typeof message.result === 'object' &&
    'protocolVersion' in message.result &&
    typeof (message.result as { protocolVersion?: unknown }).protocolVersion === 'string'
}

function isInitializeRequest(message: JSONRPCMessage): boolean {
  return 'method' in message &&
    (message as { method?: unknown }).method === 'initialize' &&
    'id' in message
}

function isResponseTo(message: JSONRPCMessage, id: string): boolean {
  return 'id' in message &&
    (message as { id?: unknown }).id === id &&
    ('result' in message || 'error' in message)
}

export function inferMcpClientKind(
  env: NodeJS.ProcessEnv = process.env,
  startPid = process.ppid,
): ExternalHealClientKind | null {
  if (isExternalHealClientKind(env.CANARY_LAB_MCP_CLIENT_KIND)) {
    return env.CANARY_LAB_MCP_CLIENT_KIND
  }
  return inferClientKindFromProcessLines(readProcessLineage(startPid))
}

export function inferClientKindFromProcessLines(lines: string[]): ExternalHealClientKind | null {
  const haystack = lines.join('\n')
  if (/\/Applications\/Claude\.app\b|Claude Helper|Claude\.app/i.test(haystack)) return 'claude-desktop'
  if (/\/Applications\/Codex\.app\b|Codex Helper|Codex\.app/i.test(haystack)) return 'codex-desktop'
  if (/(^|[\s/])claude(?:\s|$)|claude-code/i.test(haystack)) return 'claude-cli'
  if (/(^|[\s/])codex(?:\s|$)/i.test(haystack)) return 'codex-cli'
  return null
}

function readProcessLineage(startPid: number): string[] {
  if (process.platform === 'win32') return []
  const lines: string[] = []
  let pid = startPid
  for (let depth = 0; depth < 10 && pid > 1; depth += 1) {
    const entry = readProcessEntry(pid)
    if (!entry) break
    lines.push(entry.command)
    pid = entry.ppid
  }
  return lines
}

function readProcessEntry(pid: number): { ppid: number; command: string } | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=,command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const match = out.match(/^(\d+)\s+([\s\S]+)$/)
    if (!match) return null
    return { ppid: Number(match[1]), command: match[2] }
  } catch {
    return null
  }
}

function isExternalHealClientKind(value: unknown): value is ExternalHealClientKind {
  return value === 'claude-cli' ||
    value === 'claude-desktop' ||
    value === 'codex-cli' ||
    value === 'codex-desktop' ||
    value === 'other'
}

runAsScript(module, main)
