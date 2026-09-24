import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakeMcpClients } from '../../tools/test-helpers/mcp-clients'

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}))

vi.mock('child_process', () => ({ execFileSync: mocks.execFileSync }))

const { registerCanaryLabMcp: register, resolveMcpInvocation, isEphemeralNpxInstall, isTempInstallPath } = await import('./mcp-registration')

let homeDir: string
function registerCanaryLabMcp(target: 'codex' | 'claude', opts: Parameters<typeof register>[1] = {}) {
  return register(target, { ...opts, homeDir })
}
afterEach(() => fs.rmSync(homeDir, { recursive: true, force: true }))

const lookup = process.platform === 'win32' ? 'where' : 'which'

function claudeAddJsonArgs(command: string, cliPath: string): string[] {
  return [
    'mcp',
    'add-json',
    '--scope',
    'user',
    'Canary_Lab',
    JSON.stringify({
      type: 'stdio',
      command,
      args: [cliPath, 'mcp', '--profile', 'compact'],
      alwaysLoad: true,
    }),
  ]
}

beforeEach(() => {
  mocks.execFileSync.mockReset()
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-registration-'))
})

function cliAvailable(command: string, outputByGet?: string): void {
  const commandValue = outputByGet?.match(/command: (.+)/i)?.[1] ?? 'other'
  const argsValue = outputByGet?.match(/args: (.+)/i)?.[1]?.split(' ') ?? []
  const entry = { type: 'stdio', command: commandValue, args: argsValue, alwaysLoad: true }
  const entries = outputByGet === undefined ? {} : { Canary_Lab: command === 'codex' ? { transport: entry } : entry }
  mocks.execFileSync.mockImplementation(fakeMcpClients(homeDir, { available: [command], [command]: entries }))
}

describe('registerCanaryLabMcp', () => {
  it('repairs a disabled entry and stale workspace pin even when command and args match', () => {
    mocks.execFileSync.mockImplementation(fakeMcpClients(homeDir, { codex: { Canary_Lab: {
      enabled: false,
      transport: { type: 'stdio', command: '/usr/bin/node', args: ['/opt/cli.js', 'mcp', '--profile', 'compact'], env: {
        CANARY_LAB_PROJECT_ROOT: '/work/stale', CUSTOM_VALUE: 'retained',
      } },
    } } }))
    const result = registerCanaryLabMcp('codex', { execPath: '/usr/bin/node', cliPath: '/opt/cli.js', force: true, log: () => {} })
    expect(result).toEqual({ status: 'configured', invocation: {
      command: '/usr/bin/node', args: ['/opt/cli.js', 'mcp', '--profile', 'compact'], env: { CUSTOM_VALUE: 'retained' },
    } })
  })

  it.each(['Canary_Lab', 'canary-lab'])('preserves disabled %s during automatic refresh', (name) => {
    mocks.execFileSync.mockImplementation(fakeMcpClients(homeDir, { codex: { [name]: {
      enabled: false, transport: { type: 'stdio', command: 'old-node', args: ['old-cli', 'mcp'] },
    } } }))
    expect(registerCanaryLabMcp('codex', { force: true, refreshOnly: true, log: () => {} }).status).toBe('skipped')
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['remove']), expect.anything())
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
  })

  it('compares exact argument boundaries and supports paths containing spaces', () => {
    const command = '/runtime with spaces/node'
    const cliPath = '/package with spaces/cli.js'
    mocks.execFileSync.mockImplementation(fakeMcpClients(homeDir, { codex: { Canary_Lab: {
      transport: { type: 'stdio', command, args: [cliPath, 'mcp', '--profile', 'compact', '--url', 'http://wrong/mcp'] },
    } } }))
    expect(registerCanaryLabMcp('codex', { execPath: command, cliPath, log: () => {} }).status).toBe('conflict')
    expect(registerCanaryLabMcp('codex', { execPath: command, cliPath, force: true, log: () => {} }).status).toBe('configured')
    expect(registerCanaryLabMcp('codex', { execPath: command, cliPath, force: true, log: () => {} }).status).toBe('unchanged')
  })

  it.each(['Canary_Lab', 'canary-lab'])('preserves custom cwd and inherited environment settings on %s during refresh', (name) => {
    mocks.execFileSync.mockImplementation(fakeMcpClients(homeDir, { codex: { [name]: {
      transport: { type: 'stdio', command: 'old-node', args: ['old-cli'], cwd: '/work/custom', env_vars: ['CUSTOM_TOKEN'] },
    } } }))
    expect(registerCanaryLabMcp('codex', { force: true, refreshOnly: true, log: () => {} }).status).toBe('skipped')
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['remove']), expect.anything())
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
  })

  it('retains custom environment values when migrating a legacy entry', () => {
    mocks.execFileSync.mockImplementation(fakeMcpClients(homeDir, { codex: { 'canary-lab': {
      transport: { type: 'stdio', command: 'old-node', args: [], env: { CUSTOM_VALUE: 'keep' } },
    } } }))
    expect(registerCanaryLabMcp('codex', { force: true, log: () => {} })).toMatchObject({
      status: 'configured', invocation: { env: { CUSTOM_VALUE: 'keep' } },
    })
  })

  it('does not leak existing environment values in dry-run output', () => {
    mocks.execFileSync.mockImplementation(fakeMcpClients(homeDir, { codex: { Canary_Lab: {
      transport: { type: 'stdio', command: 'old-node', args: [], env: { CUSTOM_TOKEN: 'private-value' } },
    } } }))
    const lines: string[] = []
    registerCanaryLabMcp('codex', { dryRun: true, log: (line) => lines.push(line) })
    expect(lines.join('\n')).toContain('CUSTOM_TOKEN=<set>')
    expect(lines.join('\n')).not.toContain('private-value')
  })

  it('rejects an add which does not persist the requested config', () => {
    const client = fakeMcpClients(homeDir)
    mocks.execFileSync.mockImplementation((command: string, args: string[]) =>
      args[1] === 'add' ? Buffer.from('') : client(command, args))
    expect(() => registerCanaryLabMcp('codex', { log: () => {} })).toThrow(/saved configuration does not match/)
  })

  it('skips Codex when the CLI is missing', () => {
    const lines: string[] = []
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('missing')
    })

    registerCanaryLabMcp('codex', { log: (line) => lines.push(line) })

    expect(lines).toEqual(['Codex MCP skipped: codex CLI not found on PATH.'])
    expect(mocks.execFileSync).toHaveBeenCalledExactlyOnceWith(lookup, ['codex'], { stdio: 'ignore' })
  })

  it('adds Codex MCP when no canary-lab server exists', () => {
    const lines: string[] = []
    cliAvailable('codex')

    registerCanaryLabMcp('codex', {
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith('codex', ['mcp', 'get', 'Canary_Lab', '--json'], expect.anything())
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'Canary_Lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'compact'],
      { stdio: 'ignore' },
    )
    expect(lines).toContain('Codex MCP configured')
  })

  it('leaves matching Codex MCP config untouched', () => {
    const lines: string[] = []
    cliAvailable('codex', 'canary-lab\n  command: /usr/bin/node\n  args: /opt/canary-lab/dist/scripts/cli.js mcp --profile compact\n')

    registerCanaryLabMcp('codex', {
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
    expect(lines).toEqual(['Codex MCP already configured'])
  })

  it('treats a legacy npx config as a conflict so upgrade can replace it', () => {
    const lines: string[] = []
    cliAvailable('codex', 'canary-lab\n  command: npx\n  args: -y canary-lab mcp --profile repair\n')

    registerCanaryLabMcp('codex', {
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
    expect(lines[0]).toContain('Codex MCP is already configured differently')
  })

  it('treats a no-profile absolute config as stale', () => {
    const lines: string[] = []
    cliAvailable('codex', 'canary-lab\n  command: /usr/bin/node\n  args: /opt/canary-lab/dist/scripts/cli.js mcp\n')

    registerCanaryLabMcp('codex', {
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
    expect(lines[0]).toContain('Codex MCP is already configured differently')
  })

  it('warns on conflicting Codex config unless forced', () => {
    const lines: string[] = []
    cliAvailable('codex', 'canary-lab\n  command: node\n  args: other\n')

    registerCanaryLabMcp('codex', { log: (line) => lines.push(line) })

    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['remove']), expect.anything())
    expect(lines[0]).toContain('Codex MCP is already configured differently')
  })

  it('upgrades an existing lifecycle registration to compact when forced', () => {
    const lines: string[] = []
    cliAvailable('codex', 'canary-lab\n  command: /usr/bin/node\n  args: /opt/canary-lab/dist/scripts/cli.js mcp --profile lifecycle\n')

    registerCanaryLabMcp('codex', {
      force: true,
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith('codex', ['mcp', 'remove', 'Canary_Lab'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'Canary_Lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'compact'],
      { stdio: 'ignore' },
    )
    expect(lines).toContain('Codex MCP configured')
  })

  it('skips Claude when the CLI is missing', () => {
    const lines: string[] = []
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('missing')
    })

    registerCanaryLabMcp('claude', { log: (line) => lines.push(line) })

    expect(lines).toEqual(['Claude MCP skipped: claude CLI not found on PATH.'])
  })

  it('adds Claude MCP when no canary-lab server exists', () => {
    const lines: string[] = []
    cliAvailable('claude')

    registerCanaryLabMcp('claude', {
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      claudeAddJsonArgs('/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js'),
      { stdio: 'ignore' },
    )
    expect(lines).toContain('Claude MCP configured')
  })

  it('leaves matching Claude MCP config untouched', () => {
    const lines: string[] = []
    cliAvailable('claude', 'canary-lab:\n  Type: stdio\n  Command: /usr/bin/node\n  Args: /opt/canary-lab/dist/scripts/cli.js mcp --profile compact\n')

    registerCanaryLabMcp('claude', {
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).not.toHaveBeenCalledWith('claude', expect.arrayContaining(['add']), expect.anything())
    expect(lines).toEqual(['Claude MCP already configured'])
  })

  it('warns on conflicting Claude config unless forced', () => {
    const lines: string[] = []
    cliAvailable('claude', 'canary-lab:\n  Type: stdio\n  command: other\n')

    registerCanaryLabMcp('claude', { log: (line) => lines.push(line) })

    expect(mocks.execFileSync).not.toHaveBeenCalledWith('claude', expect.arrayContaining(['remove']), expect.anything())
    expect(lines[0]).toContain('Claude MCP is already configured differently')
  })

  it('replaces conflicting Claude config when forced', () => {
    const lines: string[] = []
    cliAvailable('claude', 'canary-lab:\n  Type: stdio\n  command: other\n')

    registerCanaryLabMcp('claude', {
      force: true,
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith('claude', ['mcp', 'remove', 'Canary_Lab', '-s', 'user'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      claudeAddJsonArgs('/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js'),
      { stdio: 'ignore' },
    )
    expect(lines).toContain('Claude MCP configured')
  })

  it('dry-run prints the intended command without add/remove calls', () => {
    const lines: string[] = []
    cliAvailable('codex')

    registerCanaryLabMcp('codex', {
      dryRun: true,
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(lines).toEqual([
      '[dry-run] configure Codex MCP: codex mcp add Canary_Lab -- /usr/bin/node /opt/canary-lab/dist/scripts/cli.js mcp --profile compact',
    ])
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['remove']), expect.anything())
  })
})

describe('registerCanaryLabMcp refresh', () => {
  it('skips adding when the client has no canary-lab config', () => {
    cliAvailable('codex')

    registerCanaryLabMcp('codex', {
      refreshOnly: true,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
  })

  it('replaces a legacy config without an explicit force flag', () => {
    cliAvailable('codex', 'canary-lab\n  command: npx\n  args: -y canary-lab mcp\n')

    registerCanaryLabMcp('codex', {
      refreshOnly: true,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith('codex', ['mcp', 'remove', 'Canary_Lab'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'Canary_Lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'compact'],
      { stdio: 'ignore' },
    )
  })
})

describe('registerCanaryLabMcp legacy migration', () => {
  function withServers(command: string, present: Set<string>): void {
    const entries = Object.fromEntries([...present].map((name) => [name, { type: 'stdio', command: 'old-node', args: ['old-cli', 'mcp'] }]))
    mocks.execFileSync.mockImplementation(fakeMcpClients(homeDir, { available: [command], [command]: entries }))
  }

  it('migrates a legacy canary-lab entry to Canary_Lab even under refreshOnly', () => {
    const lines: string[] = []
    withServers('claude', new Set(['canary-lab']))

    registerCanaryLabMcp('claude', {
      refreshOnly: true,
      log: (l) => lines.push(l),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith('claude', ['mcp', 'remove', 'canary-lab', '-s', 'user'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      claudeAddJsonArgs('/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js'),
      { stdio: 'ignore' },
    )
    expect(lines.join('\n')).toContain('migrated legacy "canary-lab"')
  })

  it('does not add for refreshOnly when neither legacy nor new key exists', () => {
    withServers('codex', new Set())

    registerCanaryLabMcp('codex', {
      refreshOnly: true,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['remove']), expect.anything())
  })
})

describe('isEphemeralNpxInstall', () => {
  it('flags paths inside an npx cache dir', () => {
    expect(isEphemeralNpxInstall('/Users/x/.npm/_npx/abc123/node_modules/canary-lab/dist/scripts/cli.js')).toBe(true)
  })

  it('treats a persistent install path as non-ephemeral', () => {
    expect(isEphemeralNpxInstall('/Users/x/Documents/canary-lab-workspace/node_modules/canary-lab/dist/scripts/cli.js')).toBe(false)
    expect(isEphemeralNpxInstall('/usr/local/lib/node_modules/canary-lab/dist/scripts/cli.js')).toBe(false)
  })
})

describe('resolveMcpInvocation', () => {
  it('uses an absolute node + cli.js command for a persistent install', () => {
    expect(resolveMcpInvocation({
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })).toEqual({
      command: '/usr/bin/node',
      args: ['/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'compact'],
    })
  })

  it('injects a PATH env for GUI clients so a minimal launch env can still find node', () => {
    const resolved = resolveMcpInvocation({
      execPath: '/Users/x/.nvm/versions/node/v20.20.2/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      forGui: true,
    })
    expect(resolved.command).toBe('/Users/x/.nvm/versions/node/v20.20.2/bin/node')
    expect(resolved.args).toEqual(['/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'compact'])
    expect(resolved.env?.PATH).toContain('/Users/x/.nvm/versions/node/v20.20.2/bin')
    expect(resolved.env?.PATH).toContain('/usr/bin')
  })

  it('honors an explicit pathEnv override for GUI clients', () => {
    const resolved = resolveMcpInvocation({
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      forGui: true,
      pathEnv: '/custom/bin:/bin',
    })
    expect(resolved.env).toEqual({ PATH: '/custom/bin:/bin' })
  })

  it('falls back to npx canary-lab@latest for an ephemeral npx-cache install', () => {
    expect(resolveMcpInvocation({
      execPath: '/usr/bin/node',
      cliPath: '/Users/x/.npm/_npx/abc123/node_modules/canary-lab/dist/scripts/cli.js',
    })).toEqual({
      command: 'npx',
      args: ['-y', 'canary-lab@latest', 'mcp', '--profile', 'compact'],
    })
  })

  it('attaches a PATH and workspace for the ephemeral GUI fallback', () => {
    const resolved = resolveMcpInvocation({
      execPath: '/usr/bin/node',
      cliPath: '/Users/x/.npm/_npx/abc123/node_modules/canary-lab/dist/scripts/cli.js',
      forGui: true,
      projectRoot: '/work/canary-workspace',
    })
    expect(resolved.env?.PATH).toContain('/usr/bin')
    expect(resolved.env?.CANARY_LAB_PROJECT_ROOT).toBe('/work/canary-workspace')
  })
})

describe('isTempInstallPath', () => {
  // The live failure: a Claude Desktop entry pointed at a demo install under the temp
  // dir, which the next sweep deletes — leaving a dead MCP server the user never
  // configured. os.tmpdir() is the authority so this holds on every platform.
  it('flags an install under the OS temp dir', () => {
    const cli = path.join(os.tmpdir(), 'canary-lab-demo-abc', 'demo-project', 'node_modules', 'canary-lab', 'dist', 'apps', 'cli', 'cli.js')
    expect(isTempInstallPath(cli)).toBe(true)
  })

  // Load-bearing on macOS: os.tmpdir() reports `/var/folders/…` while the path a real
  // install resolves to is `/private/var/folders/…`. A raw-only prefix test returns
  // false here, which is exactly the bug this guard exists to prevent.
  it('flags the realpath form of the temp dir, not just the raw one', () => {
    const real = fs.realpathSync(os.tmpdir())
    expect(isTempInstallPath(path.join(real, 'canary-lab-smoke-x', 'smoke-project', 'node_modules', 'canary-lab', 'dist', 'apps', 'cli', 'cli.js'))).toBe(true)
  })

  it('leaves a durable install alone', () => {
    expect(isTempInstallPath('/Users/x/Documents/canary-lab-workspace/node_modules/canary-lab/dist/scripts/cli.js')).toBe(false)
    expect(isTempInstallPath('/usr/local/lib/node_modules/canary-lab/dist/scripts/cli.js')).toBe(false)
  })
})
