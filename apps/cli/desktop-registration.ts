import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveMcpInvocation, resolveCliPath, LEGACY_SERVER_NAMES, type ResolvedMcpInvocation } from './mcp-registration'

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

export function registerClaudeDesktopMcp(opts: DesktopRegistrationOptions = {}): void {
  const log = opts.log ?? console.log
  const configPath = opts.configPath ?? claudeDesktopConfigPath()
  const invocation = resolveMcpInvocation({
    execPath: opts.execPath ?? process.execPath,
    cliPath: opts.cliPath ?? resolveCliPath(),
    forGui: true,
    pathEnv: opts.pathEnv,
  })

  if (opts.dryRun) {
    log(`[dry-run] configure Claude Desktop MCP: ${configPath} -> ${invocation.command} ${invocation.args.join(' ')}`)
    return
  }

  const config = readConfig(configPath)
  const servers = config.mcpServers && typeof config.mcpServers === 'object'
    ? config.mcpServers as Record<string, unknown>
    : {}

  // Migrate any legacy-named entry to SERVER_NAME so existing Desktop users pick
  // up the rename automatically. A legacy entry counts as "already configured",
  // so the migration proceeds even under refreshOnly.
  const legacyKeys = LEGACY_SERVER_NAMES.filter((name) => name !== SERVER_NAME && name in servers)
  for (const key of legacyKeys) delete servers[key]
  const migratedLegacy = legacyKeys.length > 0
  const migrateLog = `Claude Desktop MCP: migrated legacy entry to "${SERVER_NAME}"`

  const existing = servers[SERVER_NAME]

  if (existing !== undefined && sameEntry(existing, invocation)) {
    // New key already correct — but if we removed a legacy duplicate we still
    // have to persist that deletion.
    if (migratedLegacy) {
      config.mcpServers = servers
      writeConfig(configPath, config)
      log(migrateLog)
    } else {
      log('Claude Desktop MCP already configured')
    }
    return
  }

  if (existing !== undefined && !opts.force && !opts.refreshOnly) {
    log('Claude Desktop MCP is already configured differently. Rerun `npx canary-lab setup --force` to replace it.')
    return
  }

  if (existing === undefined && opts.refreshOnly && !migratedLegacy) {
    return
  }

  servers[SERVER_NAME] = invocationEntry(invocation)
  config.mcpServers = servers
  writeConfig(configPath, config)
  log(migratedLegacy ? migrateLog : 'Claude Desktop MCP configured')
}

function invocationEntry(invocation: ResolvedMcpInvocation): Record<string, unknown> {
  return invocation.env
    ? { command: invocation.command, args: invocation.args, env: invocation.env }
    : { command: invocation.command, args: invocation.args }
}

function sameEntry(value: unknown, desired: ResolvedMcpInvocation): boolean {
  if (!value || typeof value !== 'object') return false
  const entry = value as { command?: unknown; args?: unknown; env?: { PATH?: unknown } }
  return entry.command === desired.command &&
    JSON.stringify(entry.args) === JSON.stringify(desired.args) &&
    (entry.env?.PATH ?? undefined) === (desired.env?.PATH ?? undefined)
}

function readConfig(configPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function writeConfig(configPath: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}
