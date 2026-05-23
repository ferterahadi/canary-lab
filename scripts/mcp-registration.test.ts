import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}))

vi.mock('child_process', () => ({ execFileSync: mocks.execFileSync }))

const { registerCanaryLabMcp } = await import('./mcp-registration')

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

    registerCanaryLabMcp('codex', { log: (line) => lines.push(line) })

    expect(mocks.execFileSync).toHaveBeenCalledWith('codex', ['mcp', 'get', 'canary-lab'], expect.anything())
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'canary-lab', '--', 'npx', '-y', 'canary-lab', 'mcp'],
      { stdio: 'ignore' },
    )
    expect(lines).toContain('Codex MCP configured')
  })

  it('leaves matching Codex MCP config untouched', () => {
    const lines: string[] = []
    cliAvailable('codex', 'canary-lab\n  command: npx\n  args: -y canary-lab mcp\n')

    registerCanaryLabMcp('codex', { log: (line) => lines.push(line) })

    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
    expect(lines).toEqual(['Codex MCP already configured'])
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

    registerCanaryLabMcp('codex', { force: true, log: (line) => lines.push(line) })

    expect(mocks.execFileSync).toHaveBeenCalledWith('codex', ['mcp', 'remove', 'canary-lab'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'canary-lab', '--', 'npx', '-y', 'canary-lab', 'mcp'],
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

    registerCanaryLabMcp('claude', { log: (line) => lines.push(line) })

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'canary-lab', 'http://localhost:7421/mcp'],
      { stdio: 'ignore' },
    )
    expect(lines).toContain('Claude MCP configured')
  })

  it('leaves matching Claude MCP config untouched', () => {
    const lines: string[] = []
    cliAvailable('claude', 'canary-lab:\n  Type: http\n  URL: http://localhost:7421/mcp\n')

    registerCanaryLabMcp('claude', { log: (line) => lines.push(line) })

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

    registerCanaryLabMcp('claude', { force: true, log: (line) => lines.push(line) })

    expect(mocks.execFileSync).toHaveBeenCalledWith('claude', ['mcp', 'remove', 'canary-lab', '-s', 'user'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'canary-lab', 'http://localhost:7421/mcp'],
      { stdio: 'ignore' },
    )
    expect(lines).toContain('Claude MCP configured')
  })

  it('dry-run prints the intended command without add/remove calls', () => {
    const lines: string[] = []
    cliAvailable('codex')

    registerCanaryLabMcp('codex', { dryRun: true, log: (line) => lines.push(line) })

    expect(lines).toEqual(['[dry-run] configure Codex MCP: codex mcp add canary-lab -- npx -y canary-lab mcp'])
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['remove']), expect.anything())
  })
})
