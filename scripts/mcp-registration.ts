import { execFileSync } from 'child_process'
import path from 'path'
import { DEFAULT_CANARY_LAB_MCP_PROFILE } from '../apps/web-server/mcp/tools'

export type McpRegistrationTarget = 'codex' | 'claude'

export interface ResolvedMcpInvocation {
  command: string
  args: string[]
  env?: Record<string, string>
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
}

// Client config key + display name. Claude Code/Codex show the registered key
// verbatim (the server's advertised title is ignored), so this drives what the
// user sees in `/mcp`. Tool prefixes normalize it to `mcp__Canary_Lab__*`.
const SERVER_NAME = 'Canary_Lab'
// npm package id used in the portable `npx <pkg>@latest` invocation — must stay
// the publishable package name, not the display key.
const PACKAGE_NAME = 'canary-lab'

// Older builds registered the server under this key. `setup`/`upgrade` migrate
// any such entry to SERVER_NAME so existing users pick up the rename
// automatically — no manual `claude mcp remove canary-lab -s user` needed.
export const LEGACY_SERVER_NAMES = ['canary-lab']

// After build, dist/scripts/mcp-registration.js sits next to cli.js, so the
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

export function resolveMcpInvocation(opts: {
  execPath: string
  cliPath: string
  forGui?: boolean
  pathEnv?: string
}): ResolvedMcpInvocation {
  if (isEphemeralNpxInstall(opts.cliPath)) {
    return { command: 'npx', args: ['-y', `${PACKAGE_NAME}@latest`, 'mcp', '--profile', DEFAULT_CANARY_LAB_MCP_PROFILE] }
  }
  const invocation: ResolvedMcpInvocation = {
    command: opts.execPath,
    args: [opts.cliPath, 'mcp', '--profile', DEFAULT_CANARY_LAB_MCP_PROFILE],
  }
  // GUI clients (Claude/Codex Desktop) launch servers with a minimal env that
  // often lacks the nvm/homebrew node dir, so embed an explicit PATH.
  if (opts.forGui) {
    invocation.env = { PATH: opts.pathEnv ?? defaultGuiPath(opts.execPath) }
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
): void {
  const log = opts.log ?? console.log
  const command = target
  const label = target === 'codex' ? 'Codex' : 'Claude'

  if (!commandAvailable(command)) {
    log(`${label} MCP skipped: ${command} CLI not found on PATH.`)
    return
  }

  const invocation = resolveMcpInvocation({
    execPath: opts.execPath ?? process.execPath,
    cliPath: opts.cliPath ?? resolveCliPath(),
  })
  const addArgs = addArgsFor(target, invocation)
  const legacyPresent = LEGACY_SERVER_NAMES.filter((name) => clientHasServer(target, name))

  if (opts.dryRun) {
    for (const name of legacyPresent) {
      log(`[dry-run] migrate ${label} MCP: ${renderCommand(command, removeServerArgs(target, name))}`)
    }
    log(`[dry-run] configure ${label} MCP: ${renderCommand(command, addArgs)}`)
    return
  }

  for (const name of legacyPresent) {
    execFileSync(command, removeServerArgs(target, name), { stdio: 'ignore' })
    log(`${label} MCP: migrated legacy "${name}" entry to "${SERVER_NAME}"`)
  }

  const current = getExistingConfig(target, invocation)
  if (current.status === 'expected') {
    log(`${label} MCP already configured`)
    return
  }

  // refreshOnly never adds to a client that was never configured — but a legacy
  // entry we just removed counts as "was configured", so the rename still lands.
  if (current.status === 'missing' && opts.refreshOnly && legacyPresent.length === 0) {
    return
  }

  if (current.status === 'conflict') {
    if (!opts.force && !opts.refreshOnly) {
      log(`${label} MCP is already configured differently. Rerun \`npx canary-lab setup --force\` to replace it.`)
      return
    }
    execFileSync(command, removeArgsFor(target), { stdio: 'ignore' })
  }

  execFileSync(command, addArgs, { stdio: 'ignore' })
  log(`${label} MCP configured`)
}

function getExistingConfig(
  target: McpRegistrationTarget,
  invocation: ResolvedMcpInvocation,
): { status: 'missing' | 'expected' | 'conflict' } {
  try {
    const output = execFileSync(target, ['mcp', 'get', SERVER_NAME], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return expectedConfig(output, invocation) ? { status: 'expected' } : { status: 'conflict' }
  } catch {
    return { status: 'missing' }
  }
}

// True when the client has any entry under `name` (used to detect legacy keys
// to migrate). A non-zero `mcp get` exit means no such server.
function clientHasServer(target: McpRegistrationTarget, name: string): boolean {
  try {
    execFileSync(target, ['mcp', 'get', name], { stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

// The registered command is now machine-specific (absolute node + cli.js), so
// match the live `mcp get` output against the invocation we would write rather
// than a fixed string. A legacy `npx -y canary-lab mcp` config therefore reads
// as a conflict and is replaced on `setup --force` / `upgrade`.
function expectedConfig(output: string, invocation: ResolvedMcpInvocation): boolean {
  return output.includes(invocation.command) && output.includes(invocation.args.join(' '))
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
  return target === 'codex'
    ? ['mcp', 'add', SERVER_NAME, ...tail]
    : ['mcp', 'add', '--scope', 'user', SERVER_NAME, ...tail]
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
  return [command, ...args].join(' ')
}
