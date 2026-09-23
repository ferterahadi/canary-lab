import { execFileSync } from 'child_process'
import path from 'path'
import { claudeGlobalConfigFile } from '../web-server/src/features/agent-sessions/logic/agent-workspace-trust'
import { isRecord, readMcpConfig } from './mcp-config'
import type { CanaryLabMcpProfile } from '../web-server/src/mcp/tools'
import { isUnderTempDir } from '../../shared/runtime/temp-path'

export type McpRegistrationTarget = 'codex' | 'claude'

export interface ResolvedMcpInvocation {
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface McpRegistrationOptions {
  dryRun?: boolean
  force?: boolean
  log?: (msg: string) => void
  /** Node binary used to launch the bridge. Defaults to the running node. */
  execPath?: string
  /** Absolute path to the installed `cli.js`. Defaults to this build's sibling. */
  cliPath?: string
  /** Re-point an already-configured client only; never add to a client that
   *  has no canary-lab entry, and heal a stale/legacy entry without prompting. */
  refreshOnly?: boolean
  homeDir?: string
}

export type McpRegistrationResult =
  | { status: 'configured' | 'unchanged'; invocation: ResolvedMcpInvocation }
  | { status: 'skipped'; reason: string }
  | { status: 'conflict'; reason: string }

export interface SavedMcpEntry {
  invocation: ResolvedMcpInvocation | null
  enabled: boolean
  alwaysLoad?: boolean
  envVars?: string[]
}

// Client config key + display name. Claude Code/Codex show the registered key
// verbatim (the server's advertised title is ignored), so this drives what the
// user sees in `/mcp`. Tool prefixes normalize it to `mcp__Canary_Lab__*`.
const SERVER_NAME = 'Canary_Lab'
// npm package id used in the portable `npx <pkg>@latest` invocation — must stay
// the publishable package name, not the display key.
const PACKAGE_NAME = 'canary-lab'

/** `setup` installs every focused skill, then registers only the one-tool compact
 *  MCP surface whose `exec` dispatcher can reach every atomic workflow. Manual
 *  clients can still opt into focused or full direct-tool debugging surfaces. */
export const REGISTERED_CANARY_LAB_MCP_PROFILE: CanaryLabMcpProfile = 'compact'

// Older builds registered the server under this key. `setup`/`upgrade` migrate
// any such entry to SERVER_NAME so existing users pick up the rename
// automatically — no manual `claude mcp remove canary-lab -s user` needed.
export const LEGACY_SERVER_NAMES = ['canary-lab']

// After build, dist/apps/cli/mcp-registration.js sits next to cli.js, so the
// running install can hand clients an absolute path to the exact version that
// ran `setup` — no npx version resolution, no PATH dependence, no skew with
// whatever npm `latest` happens to be.
export function resolveCliPath(): string {
  return path.join(__dirname, 'cli.js')
}

// npx installs land in a content-hashed `_npx` cache dir that npm garbage
// collects. Pinning a client config to that path would rot, so for an
// ephemeral install we register the portable `npx canary-lab@latest` form
// instead (which also auto-follows future publishes).
export function isEphemeralNpxInstall(cliPath: string): boolean {
  return cliPath.split(/[\\/]/).includes('_npx')
}

// Sibling of the above, for the other class of install whose path rots: anything
// under the OS temp dir. Older demo releases and the tarball smoke test install
// canary-lab there, so a `ui` booted from one would write ITS path into the
// user's GLOBAL client
// config. Observed live: a Claude Desktop entry aimed at a
// `/private/var/folders/.../T/canary-lab-demo-*/` cli.js, which the next temp sweep
// deletes and the user is left with a dead MCP server they never configured.
//
// Deliberately NOT the same mechanism as CANARY_LAB_SKIP_CLIENT_MCP: that env var
// opts a KNOWN harness out and the harness has to remember to set it. This is
// structural, so an interactive `canary-lab ui` in a demo workspace — which nobody
// thought to guard — cannot claim global pointers either. `setup` run from a durable
// workspace remains the supported way to move them and is unaffected.
export function isTempInstallPath(cliPath: string): boolean {
  return isUnderTempDir(cliPath)
}

export function resolveMcpInvocation(opts: {
  execPath: string
  cliPath: string
  forGui?: boolean
  pathEnv?: string
  /** Workspace this registration is for. GUI clients only — see below. */
  projectRoot?: string
}): ResolvedMcpInvocation {
  const invocation: ResolvedMcpInvocation = isEphemeralNpxInstall(opts.cliPath)
    ? { command: 'npx', args: ['-y', `${PACKAGE_NAME}@latest`, 'mcp', '--profile', REGISTERED_CANARY_LAB_MCP_PROFILE] }
    : { command: opts.execPath, args: [opts.cliPath, 'mcp', '--profile', REGISTERED_CANARY_LAB_MCP_PROFILE] }
  // GUI clients (Claude/Codex Desktop) launch servers with a minimal env that
  // often lacks the nvm/homebrew node dir, so embed an explicit PATH.
  if (opts.forGui) {
    invocation.env = { PATH: opts.pathEnv ?? defaultGuiPath(opts.execPath) }
    // A GUI client has no meaningful cwd, so the bridge cannot infer which
    // workspace it belongs to the way a terminal session can. Pin it. Only the
    // GUI needs this: a CLI client resolves the enclosing workspace from its own
    // cwd, and when neither pins one the live-server record decides.
    if (opts.projectRoot) invocation.env.CANARY_LAB_PROJECT_ROOT = path.resolve(opts.projectRoot)
  }
  return invocation
}

function defaultGuiPath(execPath: string): string {
  const nodeDir = path.dirname(execPath)
  const standard = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return [nodeDir, ...standard.filter((dir) => dir !== nodeDir)].join(':')
}

export function registerCanaryLabMcp(
  target: McpRegistrationTarget,
  opts: McpRegistrationOptions = {},
): McpRegistrationResult {
  const log = opts.log ?? console.log
  const command = target
  const label = target === 'codex' ? 'Codex' : 'Claude'

  if (!commandAvailable(command)) {
    log(`${label} MCP skipped: ${command} CLI not found on PATH.`)
    return { status: 'skipped', reason: `${command} CLI not found on PATH` }
  }

  const current = readRegisteredMcp(target, opts)
  const legacy = LEGACY_SERVER_NAMES.map((name) => ({ name, entry: readRegisteredMcp(target, opts, name) }))
  const legacyPresent = legacy.filter(({ entry }) => entry !== null).map(({ name }) => name)
  const previous = current ?? legacy.find(({ entry }) => entry !== null)?.entry
  if (opts.refreshOnly && ((current && !current.enabled) || (!current && legacy.some(({ entry }) => entry && !entry.enabled)))) {
    log(`${label} MCP refresh skipped: the integration is disabled.`)
    return { status: 'skipped', reason: 'integration is disabled' }
  }
  if (opts.refreshOnly && (previous?.invocation?.cwd || previous?.envVars?.length)) {
    log(`${label} MCP refresh skipped: custom cwd or env_vars requires explicit setup --force.`)
    return { status: 'skipped', reason: 'custom cwd or env_vars requires explicit setup --force' }
  }
  const invocation = resolveMcpInvocation({
    execPath: opts.execPath ?? process.execPath,
    cliPath: opts.cliPath ?? resolveCliPath(),
  })
  // Preserve user environment values while explicit setup removes a legacy CLI
  // workspace pin. Terminal clients select their workspace from their own cwd.
  const env = { ...previous?.invocation?.env }
  if (!opts.refreshOnly) delete env.CANARY_LAB_PROJECT_ROOT
  if (Object.keys(env).length) invocation.env = env
  const addArgs = addArgsFor(target, invocation)

  if (opts.dryRun) {
    for (const name of legacyPresent) {
      log(`[dry-run] migrate ${label} MCP: ${renderCommand(command, removeServerArgs(target, name))}`)
    }
    log(`[dry-run] configure ${label} MCP: ${renderCommand(command, addArgs)}`)
    return { status: 'skipped', reason: 'dry run' }
  }

  if (current && savedMcpMatches(current, invocation, target === 'claude')) {
    removeLegacyEntries()
    log(`${label} MCP already configured`)
    return { status: 'unchanged', invocation: current.invocation! }
  }

  // A legacy entry counts as previously configured, so refresh can migrate it.
  if (!current && opts.refreshOnly && legacyPresent.length === 0) {
    return { status: 'skipped', reason: 'not previously configured' }
  }

  if (current) {
    if (!opts.force && !opts.refreshOnly) {
      log(`${label} MCP is already configured differently. Rerun \`npx canary-lab setup --force\` to replace it.`)
      return { status: 'conflict', reason: 'saved configuration differs; rerun setup --force' }
    }
    execFileSync(command, removeArgsFor(target), { stdio: 'ignore' })
  }

  execFileSync(command, addArgs, { stdio: 'ignore' })
  const saved = readRegisteredMcp(target, opts)
  if (!saved || !savedMcpMatches(saved, invocation, target === 'claude')) {
    throw new Error(`${label} MCP saved configuration does not match the requested setup.`)
  }
  removeLegacyEntries()
  log(`${label} MCP configured`)
  return { status: 'configured', invocation: saved.invocation! }

  function removeLegacyEntries(): void {
    for (const name of legacyPresent) {
      execFileSync(command, removeServerArgs(target, name), { stdio: 'ignore' })
      log(`${label} MCP: migrated legacy "${name}" entry to "${SERVER_NAME}"`)
    }
  }
}

export function readRegisteredMcp(
  target: McpRegistrationTarget,
  opts: Pick<McpRegistrationOptions, 'homeDir'> = {},
  name = SERVER_NAME,
): SavedMcpEntry | null {
  if (target === 'claude') {
    const config = readMcpConfig(claudeGlobalConfigFile(opts.homeDir))
    const servers = config.mcpServers as Record<string, unknown> | undefined
    return servers && name in servers ? parseSavedMcpEntry(servers[name]) : null
  }
  let output: string
  try {
    output = execFileSync(target, ['mcp', 'get', name, '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer | string }
    if (/No MCP server named|missing MCP server/i.test(`${failure.message}\n${failure.stderr ?? ''}`)) return null
    throw new Error(`Cannot read ${target} MCP configuration: ${failure.message}`)
  }
  const config: unknown = JSON.parse(output)
  if (!isRecord(config)) throw new Error(`Invalid ${target} MCP configuration response`)
  const transport = isRecord(config.transport) ? config.transport : {}
  const blocked = (Array.isArray(config.disabled_tools) && config.disabled_tools.includes('exec')) ||
    (Array.isArray(config.enabled_tools) && !config.enabled_tools.includes('exec'))
  return { ...parseSavedMcpEntry({ ...transport, enabled: config.enabled !== false && !blocked }),
    envVars: Array.isArray(transport.env_vars) ? transport.env_vars.filter((value): value is string => typeof value === 'string') : [],
  }
}

// The absolute cli.js path a client currently has registered, or null when it
// has no Canary Lab entry / the client CLI is unavailable. Used to detect a
// registration left pointing at a path a package upgrade deleted — see
// findStaleCanaryLabMcp in mcp-refresh.ts.
export function registeredCliPath(target: McpRegistrationTarget): string | null {
  if (!commandAvailable(target)) return null
  try {
    return readRegisteredMcp(target)?.invocation?.args.find((arg) => /[/\\]cli\.js$/.test(arg)) ?? null
  } catch {
    return null
  }
}

export function parseSavedMcpEntry(value: unknown): SavedMcpEntry {
  if (!isRecord(value)) return { enabled: true, invocation: null }
  const env = value.env == null ? {} : value.env
  const valid = typeof value.command === 'string' && Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string') &&
    (value.type === undefined || value.type === 'stdio') && isRecord(env) && Object.values(env).every((item) => typeof item === 'string')
  return {
    enabled: value.enabled !== false && value.disabled !== true,
    alwaysLoad: value.alwaysLoad === true,
    invocation: valid ? {
      command: value.command as string,
      args: value.args as string[],
      ...(Object.keys(env as object).length ? { env: env as Record<string, string> } : {}),
      ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    } : null,
  }
}

export function savedMcpMatches(entry: SavedMcpEntry, desired: ResolvedMcpInvocation, requireAlwaysLoad = false): boolean {
  const actual = entry.invocation
  if (!actual || !entry.enabled || entry.envVars?.length || (requireAlwaysLoad && !entry.alwaysLoad)) return false
  return actual.command === desired.command && JSON.stringify(actual.args) === JSON.stringify(desired.args) &&
    actual.cwd === desired.cwd && JSON.stringify(sortedEnv(actual.env)) === JSON.stringify(sortedEnv(desired.env))
}

function sortedEnv(env: Record<string, string> = {}): [string, string][] {
  return Object.entries(env).sort(([a], [b]) => a.localeCompare(b))
}

function commandAvailable(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(lookup, [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function addArgsFor(target: McpRegistrationTarget, invocation: ResolvedMcpInvocation): string[] {
  const tail = ['--', invocation.command, ...invocation.args]
  if (target === 'codex') return ['mcp', 'add', SERVER_NAME,
    ...Object.entries(invocation.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]), ...tail]
  const config = {
    type: 'stdio',
    command: invocation.command,
    args: invocation.args,
    ...(invocation.env ? { env: invocation.env } : {}),
    alwaysLoad: true,
  }
  return ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, JSON.stringify(config)]
}

function removeArgsFor(target: McpRegistrationTarget): string[] {
  return removeServerArgs(target, SERVER_NAME)
}

function removeServerArgs(target: McpRegistrationTarget, name: string): string[] {
  return target === 'codex'
    ? ['mcp', 'remove', name]
    : ['mcp', 'remove', name, '-s', 'user']
}

function renderCommand(command: string, args: string[]): string {
  const redacted = args.map((arg, index) => {
    if (args[index - 1] === '--env') return `${arg.split('=')[0]}=<set>`
    if (arg.startsWith('{')) {
      const config = JSON.parse(arg) as { env?: Record<string, string> }
      if (config.env) config.env = Object.fromEntries(Object.keys(config.env).map((key) => [key, '<set>']))
      return JSON.stringify(config)
    }
    return arg
  })
  return [command, ...redacted].join(' ')
}
