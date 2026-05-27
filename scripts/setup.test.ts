import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readWorkspaceRegistry } from '../shared/runtime/workspace-registry'

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}))

vi.mock('child_process', () => ({ execFileSync: mocks.execFileSync }))

const { detectAgents, main, parseArgs, setup } = await import('./setup')

const tmpDirs: string[] = []
const originalCodeHome = process.env.CODEX_HOME

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-setup-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

function mkWorkspace(parent = mkTmp()): string {
  const workspace = path.join(parent, 'my-workspace')
  fs.mkdirSync(path.join(workspace, 'features'), { recursive: true })
  return workspace
}

function cliAvailable(command: string): void {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === lookup && args[0] === command) return Buffer.from('')
    if (cmd === command && args.join(' ') === 'mcp get canary-lab') {
      throw new Error('missing MCP server')
    }
    return Buffer.from('')
  })
}

beforeEach(() => {
  mocks.execFileSync.mockReset()
  mocks.execFileSync.mockImplementation(() => {
    throw new Error('missing command')
  })
  delete process.env.CODEX_HOME
})

afterEach(() => {
  if (originalCodeHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodeHome
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('parseArgs', () => {
  it('parses setup flags', () => {
    expect(parseArgs(['--workspace', '/tmp/x', '--agent', 'codex', '--dry-run', '--force'])).toEqual({
      ok: true,
      value: {
        workspace: '/tmp/x',
        agent: 'codex',
        dryRun: true,
        force: true,
      },
    })
  })

  it('rejects unknown flags and invalid agents', () => {
    expect(parseArgs(['--agent', 'bogus']).ok).toBe(false)
    expect(parseArgs(['--wat']).ok).toBe(false)
  })
})

describe('detectAgents', () => {
  it('detects Codex and Claude from home folders and CODEX_HOME', () => {
    const home = mkTmp()
    fs.mkdirSync(path.join(home, '.claude'))
    process.env.CODEX_HOME = path.join(home, 'codex-home')

    expect(detectAgents(home)).toEqual(['codex', 'claude'])
  })

  it('detects command availability on PATH', () => {
    const home = mkTmp()
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === lookup && args[0] === 'codex') return Buffer.from('')
      throw new Error('missing command')
    })

    expect(detectAgents(home)).toEqual(['codex'])
  })
})

describe('setup', () => {
  it('registers the workspace and skips agent setup when no agent is detected', () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    const lines: string[] = []

    setup({ workspace, agent: 'auto', dryRun: false, force: false }, {
      homeDir: home,
      log: (line) => { lines.push(line) },
    })

    const registry = readWorkspaceRegistry(home)
    expect(registry.workspaces).toHaveLength(1)
    expect(registry.workspaces[0].path).toBe(fs.realpathSync(workspace))
    expect(lines.join('\n')).toContain('Skipping agent integration setup')
  })

  it('installs matching agent integrations', () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })

    setup({ workspace, agent: 'auto', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
    })

    expect(fs.existsSync(path.join(home, '.codex', 'skills', 'canary-lab', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'canary-lab', 'SKILL.md'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.canary-lab', 'agent-integrations', 'canary-lab-plugin', '.mcp.json'))).toBe(true)
  })

  const verifiedStub = () => ({ status: 'verified' as const, message: '' })

  it('setup --agent codex installs the skill and configures Codex MCP', () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    cliAvailable('codex')

    setup({ workspace, agent: 'codex', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      verifyMcp: verifiedStub,
    })

    expect(fs.existsSync(path.join(home, '.codex', 'skills', 'canary-lab', 'SKILL.md'))).toBe(true)
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'canary-lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp'],
      { stdio: 'ignore' },
    )
  })

  it('setup --agent claude installs the skill and configures Claude MCP', () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    cliAvailable('claude')

    setup({ workspace, agent: 'claude', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      verifyMcp: verifiedStub,
    })

    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'canary-lab', 'SKILL.md'))).toBe(true)
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      ['mcp', 'add', '--scope', 'user', 'canary-lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp'],
      { stdio: 'ignore' },
    )
  })

  it('setup --agent all configures both MCP clients', () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    mocks.execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === lookup && (args[0] === 'codex' || args[0] === 'claude')) return Buffer.from('')
      if ((cmd === 'codex' || cmd === 'claude') && args.join(' ') === 'mcp get canary-lab') {
        throw new Error('missing MCP server')
      }
      return Buffer.from('')
    })

    setup({ workspace, agent: 'all', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      verifyMcp: verifiedStub,
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'canary-lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp'],
      { stdio: 'ignore' },
    )
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      ['mcp', 'add', '--scope', 'user', 'canary-lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp'],
      { stdio: 'ignore' },
    )
  })

  it('configures Claude Desktop when its config directory exists', () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    const desktopConfigPath = path.join(mkTmp(), 'Claude', 'claude_desktop_config.json')
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })

    setup({ workspace, agent: 'auto', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      claudeDesktopConfigPath: desktopConfigPath,
      verifyMcp: verifiedStub,
    })

    const cfg = JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8'))
    expect(cfg.mcpServers['canary-lab'].command).toBe('/usr/bin/node')
    expect(cfg.mcpServers['canary-lab'].args).toEqual(['/opt/canary-lab/dist/scripts/cli.js', 'mcp'])
    expect(cfg.mcpServers['canary-lab'].env.PATH).toContain('/usr/bin')
  })

  it('does not touch Claude Desktop when its config directory is absent', () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    const desktopConfigPath = path.join(mkTmp(), 'Claude', 'claude_desktop_config.json')

    setup({ workspace, agent: 'auto', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
      claudeDesktopConfigPath: desktopConfigPath,
      verifyMcp: verifiedStub,
    })

    expect(fs.existsSync(desktopConfigPath)).toBe(false)
  })

  it('verifies the registration and warns when the command is broken', () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    cliAvailable('codex')
    const lines: string[] = []
    const seen: string[] = []

    setup({ workspace, agent: 'codex', dryRun: false, force: false }, {
      homeDir: home,
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      verifyMcp: (invocation) => {
        seen.push(invocation.command)
        return { status: 'broken', message: 'version mismatch' }
      },
    })

    expect(seen).toEqual(['/usr/bin/node'])
    expect(lines.join('\n')).toContain('WARNING: Canary Lab MCP verification failed')
  })

  it('dry-run does not write the registry or integrations', () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })

    setup({ workspace, agent: 'auto', dryRun: true, force: false }, {
      homeDir: home,
      log: () => {},
    })

    expect(readWorkspaceRegistry(home).workspaces).toHaveLength(0)
    expect(fs.existsSync(path.join(home, '.codex', 'skills', 'canary-lab'))).toBe(false)
  })

  it('dry-run prints MCP registration intent without add/remove calls', () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    const lines: string[] = []
    cliAvailable('codex')

    setup({ workspace, agent: 'codex', dryRun: true, force: false }, {
      homeDir: home,
      log: (line) => { lines.push(line) },
    })

    expect(lines.join('\n')).toContain('[dry-run] configure Codex MCP')
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['remove']), expect.anything())
  })

  it('main exits 1 for invalid workspaces', async () => {
    const home = mkTmp()
    const exits: number[] = []
    const errors: string[] = []

    await main(['--workspace', home], {
      homeDir: home,
      error: (line) => { errors.push(line) },
      exit: (code) => { exits.push(code) },
    })

    expect(exits).toEqual([1])
    expect(errors[0]).toContain('Not a Canary Lab workspace')
  })
})
