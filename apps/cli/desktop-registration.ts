import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveMcpInvocation, resolveCliPath, LEGACY_SERVER_NAMES, parseSavedMcpEntry, savedMcpMatches, type ResolvedMcpInvocation, type SavedMcpEntry } from './mcp-registration'
import { readMcpConfig, writeMcpConfig } from './mcp-config'

// Claude Desktop shows this mcpServers key verbatim; keep it aligned with the
// CLI registration display key (mcp-registration.ts SERVER_NAME).
const SERVER_NAME = 'Canary_Lab'

export interface DesktopRegistrationOptions {
  dryRun?: boolean
  force?: boolean
  log?: (msg: string) => void
  /** Path to claude_desktop_config.json. Defaults to the per-OS location. */
  configPath?: string
  execPath?: string
  cliPath?: string
  pathEnv?: string
  /** Workspace to pin the entry to, as CANARY_LAB_PROJECT_ROOT. Desktop has no
   *  cwd of its own, so without it the bridge has to guess which workspace the
   *  GUI meant. */
  projectRoot?: string
  /** Re-point an existing entry only; never add one, and heal a stale entry
   *  without prompting. */
  refreshOnly?: boolean
}

// Claude Desktop stores stdio MCP servers in claude_desktop_config.json under
// `mcpServers` — it is NOT the same file `claude mcp add` (Claude Code) writes,
// which is why Desktop needs its own writer.
export function claudeDesktopConfigPath(
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming')
    return path.join(appData, 'Claude', 'claude_desktop_config.json')
  }
  return path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json')
}

export function claudeDesktopInstalled(configPath: string = claudeDesktopConfigPath()): boolean {
  return fs.existsSync(path.dirname(configPath))
}

/** What the write actually did. A caller that re-asserts the entry routinely
 *  (the `ui` boot re-point) needs to tell a silent no-op from a real repair:
 *  Desktop only reads this file at launch, so a repair is worthless unless the
 *  user is told to restart it. */
export type DesktopRegistrationResult = 'configured' | 'unchanged' | 'skipped'

// The absolute cli.js path Desktop currently has registered, or null when it has
// no Canary Lab entry. Desktop has no `mcp get` to query — unlike codex/claude
// (registeredCliPath in mcp-registration.ts) — so the config file is the only
// source, and a stale-path check that forgets this is blind to Desktop entirely.
// Returns null for the portable `npx canary-lab@latest` form: it pins no path,
// so it cannot rot.
export function registeredDesktopCliPath(
  configPath: string = claudeDesktopConfigPath(),
): string | null {
  let servers: unknown
  try {
    servers = readMcpConfig(configPath).mcpServers
  } catch {
    // This best-effort diagnostic never writes; setup uses the strict reader.
    return null
  }
  if (!servers || typeof servers !== 'object') return null
  const entry = (servers as Record<string, unknown>)[SERVER_NAME]
  if (!entry || typeof entry !== 'object') return null
  const args = (entry as { args?: unknown }).args
  if (!Array.isArray(args)) return null
  return args.find((arg): arg is string => typeof arg === 'string' && /[/\\]cli\.js$/.test(arg)) ?? null
}

export function readDesktopMcp(configPath: string): SavedMcpEntry | null {
  const servers = readMcpConfig(configPath).mcpServers as Record<string, unknown> | undefined
  return servers && SERVER_NAME in servers ? parseSavedMcpEntry(servers[SERVER_NAME]) : null
}

export function registerClaudeDesktopMcp(opts: DesktopRegistrationOptions = {}): DesktopRegistrationResult {
  const log = opts.log ?? console.log
  const configPath = opts.configPath ?? claudeDesktopConfigPath()
  const config = readMcpConfig(configPath)
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  const previous = parseSavedMcpEntry(servers[SERVER_NAME] ?? servers[LEGACY_SERVER_NAMES[0]])
  const projectRoot = opts.projectRoot ?? (opts.refreshOnly ? previous.invocation?.env?.CANARY_LAB_PROJECT_ROOT : undefined)
  const invocation = resolveMcpInvocation({
    execPath: opts.execPath ?? process.execPath,
    cliPath: opts.cliPath ?? resolveCliPath(),
    forGui: true,
    pathEnv: opts.pathEnv,
    ...(projectRoot ? { projectRoot } : {}),
  })
  invocation.env = { ...previous.invocation?.env, ...invocation.env }
  if (!projectRoot) delete invocation.env.CANARY_LAB_PROJECT_ROOT

  if (opts.refreshOnly && !previous.enabled) return 'skipped'

  if (opts.dryRun) {
    log(`[dry-run] configure Claude Desktop MCP: ${configPath} -> ${invocation.command} ${invocation.args.join(' ')}`)
    return 'skipped'
  }

  // Migrate any legacy-named entry to SERVER_NAME so existing Desktop users pick
  // up the rename automatically. A legacy entry counts as "already configured",
  // so the migration proceeds even under refreshOnly.
  const legacyKeys = LEGACY_SERVER_NAMES.filter((name) => name !== SERVER_NAME && name in servers)
  for (const key of legacyKeys) delete servers[key]
  const migratedLegacy = legacyKeys.length > 0
  const migrateLog = `Claude Desktop MCP: migrated legacy entry to "${SERVER_NAME}"`

  const existing = servers[SERVER_NAME]

  if (existing !== undefined && savedMcpMatches(parseSavedMcpEntry(existing), invocation, true)) {
    // New key already correct — but if we removed a legacy duplicate we still
    // have to persist that deletion.
    if (migratedLegacy) {
      config.mcpServers = servers
      writeMcpConfig(configPath, config)
      log(migrateLog)
      return 'configured'
    }
    log('Claude Desktop MCP already configured')
    return 'unchanged'
  }

  if (existing !== undefined && !opts.force && !opts.refreshOnly) {
    log('Claude Desktop MCP is already configured differently. Rerun `npx canary-lab setup --force` to replace it.')
    return 'skipped'
  }

  if (existing === undefined && opts.refreshOnly && !migratedLegacy) {
    return 'skipped'
  }

  servers[SERVER_NAME] = invocationEntry(invocation)
  config.mcpServers = servers
  writeMcpConfig(configPath, config)
  log(migratedLegacy ? migrateLog : 'Claude Desktop MCP configured')
  return 'configured'
}

function invocationEntry(invocation: ResolvedMcpInvocation): Record<string, unknown> {
  return invocation.env
    ? { command: invocation.command, args: invocation.args, env: invocation.env, alwaysLoad: true }
    : { command: invocation.command, args: invocation.args, alwaysLoad: true }
}
