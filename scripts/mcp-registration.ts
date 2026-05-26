import { execFileSync } from 'child_process'

export type McpRegistrationTarget = 'codex' | 'claude'

export interface McpRegistrationOptions {
  dryRun?: boolean
  force?: boolean
  log?: (msg: string) => void
}

const SERVER_NAME = 'canary-lab'
const CODEX_ADD_ARGS = ['mcp', 'add', SERVER_NAME, '--', 'npx', '-y', 'canary-lab', 'mcp']
const CODEX_REMOVE_ARGS = ['mcp', 'remove', SERVER_NAME]
const CLAUDE_ADD_ARGS = [
  'mcp',
  'add',
  '--scope',
  'user',
  SERVER_NAME,
  '--',
  'npx',
  '-y',
  'canary-lab',
  'mcp',
]
const CLAUDE_REMOVE_ARGS = ['mcp', 'remove', SERVER_NAME, '-s', 'user']

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

  if (opts.dryRun) {
    log(`[dry-run] configure ${label} MCP: ${renderCommand(command, addArgsFor(target))}`)
    return
  }

  const current = getExistingConfig(target)
  if (current.status === 'expected') {
    log(`${label} MCP already configured`)
    return
  }

  if (current.status === 'conflict') {
    if (!opts.force) {
      log(`${label} MCP is already configured differently. Rerun \`npx canary-lab setup --force\` to replace it.`)
      return
    }
    execFileSync(command, removeArgsFor(target), { stdio: 'ignore' })
  }

  execFileSync(command, addArgsFor(target), { stdio: 'ignore' })
  log(`${label} MCP configured`)
}

function getExistingConfig(target: McpRegistrationTarget): { status: 'missing' | 'expected' | 'conflict' } {
  try {
    const output = execFileSync(target, ['mcp', 'get', SERVER_NAME], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return expectedConfig(target, output) ? { status: 'expected' } : { status: 'conflict' }
  } catch {
    return { status: 'missing' }
  }
}

function expectedConfig(target: McpRegistrationTarget, output: string): boolean {
  if (target === 'codex') {
    return /\bcommand:\s*npx\b/.test(output) &&
      /\bargs:\s*-y\s+canary-lab\s+mcp\b/.test(output)
  }
  return /\bType:\s*stdio\b/i.test(output) &&
    /\bCommand:\s*npx\b/i.test(output) &&
    /\bArgs:\s*-y\s+canary-lab\s+mcp\b/i.test(output)
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

function addArgsFor(target: McpRegistrationTarget): string[] {
  return target === 'codex' ? CODEX_ADD_ARGS : CLAUDE_ADD_ARGS
}

function removeArgsFor(target: McpRegistrationTarget): string[] {
  return target === 'codex' ? CODEX_REMOVE_ARGS : CLAUDE_REMOVE_ARGS
}

function renderCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ')
}
