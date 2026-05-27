import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}))

vi.mock('child_process', () => ({ execFileSync: mocks.execFileSync }))

const { registerCanaryLabMcp, resolveMcpInvocation, isEphemeralNpxInstall } = await import('./mcp-registration')

const lookup = process.platform === 'win32' ? 'where' : 'which'

beforeEach(() => {
  mocks.execFileSync.mockReset()
})

function cliAvailable(command: string, outputByGet?: string): void {
  mocks.execFileSync.mockImplementation((cmd: string, args: string[], opts?: { encoding?: string }) => {
    if (cmd === lookup && args[0] === command) return Buffer.from('')
    if (cmd === command && args.join(' ') === 'mcp get canary-lab') {
      if (outputByGet === undefined) throw new Error('missing MCP server')
      return opts?.encoding === 'utf-8' ? outputByGet : Buffer.from(outputByGet)
    }
    return Buffer.from('')
  })
}

describe('registerCanaryLabMcp', () => {
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

    expect(mocks.execFileSync).toHaveBeenCalledWith('codex', ['mcp', 'get', 'canary-lab'], expect.anything())
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'canary-lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'full'],
      { stdio: 'ignore' },
    )
    expect(lines).toContain('Codex MCP configured')
  })

  it('leaves matching Codex MCP config untouched', () => {
    const lines: string[] = []
    cliAvailable('codex', 'canary-lab\n  command: /usr/bin/node\n  args: /opt/canary-lab/dist/scripts/cli.js mcp --profile full\n')

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

  it('replaces conflicting Codex config when forced', () => {
    const lines: string[] = []
    cliAvailable('codex', 'canary-lab\n  command: node\n  args: other\n')

    registerCanaryLabMcp('codex', {
      force: true,
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith('codex', ['mcp', 'remove', 'canary-lab'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'canary-lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'full'],
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
      ['mcp', 'add', '--scope', 'user', 'canary-lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'full'],
      { stdio: 'ignore' },
    )
    expect(lines).toContain('Claude MCP configured')
  })

  it('leaves matching Claude MCP config untouched', () => {
    const lines: string[] = []
    cliAvailable('claude', 'canary-lab:\n  Type: stdio\n  Command: /usr/bin/node\n  Args: /opt/canary-lab/dist/scripts/cli.js mcp --profile full\n')

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

    expect(mocks.execFileSync).toHaveBeenCalledWith('claude', ['mcp', 'remove', 'canary-lab', '-s', 'user'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      ['mcp', 'add', '--scope', 'user', 'canary-lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'full'],
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
      '[dry-run] configure Codex MCP: codex mcp add canary-lab -- /usr/bin/node /opt/canary-lab/dist/scripts/cli.js mcp --profile full',
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

    expect(mocks.execFileSync).toHaveBeenCalledWith('codex', ['mcp', 'remove', 'canary-lab'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'canary-lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'full'],
      { stdio: 'ignore' },
    )
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
      args: ['/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'full'],
    })
  })

  it('injects a PATH env for GUI clients so a minimal launch env can still find node', () => {
    const resolved = resolveMcpInvocation({
      execPath: '/Users/x/.nvm/versions/node/v20.20.2/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      forGui: true,
    })
    expect(resolved.command).toBe('/Users/x/.nvm/versions/node/v20.20.2/bin/node')
    expect(resolved.args).toEqual(['/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'full'])
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
      args: ['-y', 'canary-lab@latest', 'mcp', '--profile', 'full'],
    })
  })

  it('does not attach a PATH env for the ephemeral npx fallback', () => {
    const resolved = resolveMcpInvocation({
      execPath: '/usr/bin/node',
      cliPath: '/Users/x/.npm/_npx/abc123/node_modules/canary-lab/dist/scripts/cli.js',
      forGui: true,
    })
    expect(resolved.env).toBeUndefined()
  })
})
