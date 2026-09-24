import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakeMcpClients } from '../../tools/test-helpers/mcp-clients'
import { readWorkspaceRegistry } from '../../shared/runtime/workspace-registry'

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

function cliAvailable(command: string, homeDir: string): void {
  mocks.execFileSync.mockImplementation(fakeMcpClients(homeDir, { available: [command] }))
}

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

beforeEach(async () => {
  mocks.execFileSync.mockReset()
  mocks.execFileSync.mockImplementation(() => {
    throw new Error('missing command')
  })
  delete process.env.CODEX_HOME
  delete process.env.CANARY_LAB_SKIP_CLIENT_MCP
})

afterEach(async () => {
  if (originalCodeHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodeHome
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('parseArgs', () => {
  it('parses setup flags', async () => {
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

  it('rejects unknown flags and invalid agents', async () => {
    expect(parseArgs(['--agent', 'bogus']).ok).toBe(false)
    expect(parseArgs(['--wat']).ok).toBe(false)
  })
})

describe('detectAgents', () => {
  it('detects Codex and Claude from home folders and CODEX_HOME', async () => {
    const home = mkTmp()
    fs.mkdirSync(path.join(home, '.claude'))
    process.env.CODEX_HOME = path.join(home, 'codex-home')

    expect(detectAgents(home)).toEqual(['codex', 'claude'])
  })

  it('detects command availability on PATH', async () => {
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
  it('validates Desktop JSON before changing workspace registration or skills', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    const desktop = path.join(home, 'desktop', 'config.json')
    fs.mkdirSync(path.dirname(desktop), { recursive: true })
    fs.writeFileSync(desktop, '{invalid')
    await expect(setup({ workspace, agent: 'codex', dryRun: false, force: true }, {
      homeDir: home, claudeDesktopConfigPath: desktop, log: () => {},
    })).rejects.toThrow(/Invalid JSON/)
    expect(fs.readFileSync(desktop, 'utf-8')).toBe('{invalid')
    expect(readWorkspaceRegistry(home).workspaces).toEqual([])
    expect(fs.existsSync(path.join(home, '.agents'))).toBe(false)
  })

  it('reports each client separately and verifies the saved Desktop environment', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    const desktop = path.join(home, 'desktop', 'config.json')
    fs.mkdirSync(path.dirname(desktop), { recursive: true })
    mocks.execFileSync.mockImplementation(fakeMcpClients(home))
    const verifyMcp = vi.fn(() => ({ status: 'verified' as const, message: 'connected' }))
    const lines: string[] = []
    await setup({ workspace, agent: 'all', dryRun: false, force: true }, {
      homeDir: home, claudeDesktopConfigPath: desktop, verifyMcp, log: (line) => lines.push(line),
    })
    expect(verifyMcp).toHaveBeenCalledTimes(3)
    expect(verifyMcp.mock.calls[2][0]).toEqual(expect.objectContaining({
      env: expect.objectContaining({ CANARY_LAB_PROJECT_ROOT: workspace, PATH: expect.any(String) }),
    }))
    for (const name of ['Codex', 'Claude Code', 'Claude Desktop']) expect(lines).toContain(`${name} MCP verified: connected`)
  })

  it('returns nonzero for broken verification but distinguishes a stopped UI', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    mocks.execFileSync.mockImplementation(fakeMcpClients(home))
    const exit = vi.fn()
    const log = vi.fn()
    const options = { homeDir: home, exit, log, error: () => {} }
    await main(['--workspace', workspace, '--agent', 'codex', '--force'], {
      ...options, verifyMcp: () => ({ status: 'broken', message: 'bad command' }),
    })
    expect(exit).toHaveBeenCalledWith(1)
    exit.mockClear()
    await main(['--workspace', workspace, '--agent', 'codex', '--force'], {
      ...options, verifyMcp: () => ({ status: 'server-down', message: 'Start the UI.' }),
    })
    expect(exit).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('Codex MCP configured; connection unverified. Start the UI.')
  })

  it('registers the workspace and skips agent setup when no agent is detected', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    const lines: string[] = []

    await setup({ workspace, agent: 'auto', dryRun: false, force: false }, {
      homeDir: home,
      log: (line) => { lines.push(line) },
    })

    const registry = readWorkspaceRegistry(home)
    expect(registry.workspaces).toHaveLength(1)
    expect(registry.workspaces[0].path).toBe(fs.realpathSync(workspace))
    expect(lines.join('\n')).toContain('Skipping agent integration setup')
  })

  it('installs matching agent integrations', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })

    await setup({ workspace, agent: 'auto', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
    })

    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'canary-lab', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'canary-lab', 'SKILL.md'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.canary-lab', 'agent-integrations', 'canary-lab-plugin', '.mcp.json'))).toBe(true)
  })

  const verifiedStub = () => ({ status: 'verified' as const, message: '' })

  it('setup --agent codex installs the skill and configures Codex MCP', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    cliAvailable('codex', home)

    await setup({ workspace, agent: 'codex', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      verifyMcp: verifiedStub,
    })

    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'canary-lab', 'SKILL.md'))).toBe(true)
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'Canary_Lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'compact'],
      { stdio: 'ignore' },
    )
  })

  it('setup --agent claude installs the skill and configures Claude MCP', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    cliAvailable('claude', home)

    await setup({ workspace, agent: 'claude', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      verifyMcp: verifiedStub,
    })

    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'canary-lab', 'SKILL.md'))).toBe(true)
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      claudeAddJsonArgs('/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js'),
      { stdio: 'ignore' },
    )
  })

  it('setup --agent all configures both MCP clients', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    mocks.execFileSync.mockImplementation(fakeMcpClients(home))

    await setup({ workspace, agent: 'all', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      verifyMcp: verifiedStub,
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'Canary_Lab', '--', '/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'compact'],
      { stdio: 'ignore' },
    )
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      claudeAddJsonArgs('/usr/bin/node', '/opt/canary-lab/dist/scripts/cli.js'),
      { stdio: 'ignore' },
    )
  })

  it('configures Claude Desktop when its config directory exists', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    const desktopConfigPath = path.join(mkTmp(), 'Claude', 'claude_desktop_config.json')
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })

    await setup({ workspace, agent: 'auto', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      claudeDesktopConfigPath: desktopConfigPath,
      verifyMcp: verifiedStub,
    })

    const cfg = JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8'))
    expect(cfg.mcpServers['Canary_Lab'].command).toBe('/usr/bin/node')
    expect(cfg.mcpServers['Canary_Lab'].args).toEqual(['/opt/canary-lab/dist/scripts/cli.js', 'mcp', '--profile', 'compact'])
    expect(cfg.mcpServers['Canary_Lab'].alwaysLoad).toBe(true)
    expect(cfg.mcpServers['Canary_Lab'].env.PATH).toContain('/usr/bin')
    // The workspace `setup` ran in is pinned, so a Desktop session reaches THIS
    // workspace no matter what else is live — the documented demo hand-off
    // depends on it, because Desktop has no cwd to infer one from.
    expect(cfg.mcpServers['Canary_Lab'].env.CANARY_LAB_PROJECT_ROOT).toBe(workspace)
  })

  it('does not touch Claude Desktop when its config directory is absent', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    const desktopConfigPath = path.join(mkTmp(), 'Claude', 'claude_desktop_config.json')

    await setup({ workspace, agent: 'auto', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
      claudeDesktopConfigPath: desktopConfigPath,
      verifyMcp: verifiedStub,
    })

    expect(fs.existsSync(desktopConfigPath)).toBe(false)
  })

  it('CANARY_LAB_SKIP_CLIENT_MCP installs the skill but never touches client configs', async () => {
    process.env.CANARY_LAB_SKIP_CLIENT_MCP = '1'
    const home = mkTmp()
    const workspace = mkWorkspace()
    cliAvailable('claude', home)
    const desktopConfigPath = path.join(mkTmp(), 'Claude', 'claude_desktop_config.json')
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })
    const lines: string[] = []

    await setup({ workspace, agent: 'claude', dryRun: false, force: false }, {
      homeDir: home,
      log: (line) => { lines.push(line) },
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      claudeDesktopConfigPath: desktopConfigPath,
      verifyMcp: verifiedStub,
    })

    // Scaffolding still happens — only the live-client MCP registration is skipped.
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'canary-lab', 'SKILL.md'))).toBe(true)
    expect(lines.join('\n')).toContain('Skipping client MCP registration')
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('claude', expect.arrayContaining(['add-json']), expect.anything())
    expect(fs.existsSync(desktopConfigPath)).toBe(false)
  })

  // Structural twin of the env-flag guard above. The flag only protects a harness
  // that remembers to set it; a demo or smoke workspace scaffolded under the OS
  // temp dir reaches `setup` through `init` WITHOUT it, and the temp cli.js it
  // registers into the user's global config dies with the next temp sweep. Observed
  // live as a global Canary_Lab entry aimed at a canary-lab-demo-* temp path.
  // Implicit runs only: an explicit `setup` in a temp workspace registers (below).
  it('never registers a client when an implicit setup runs under the temp dir', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    cliAvailable('claude', home)
    const desktopConfigPath = path.join(mkTmp(), 'Claude', 'claude_desktop_config.json')
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })
    const lines: string[] = []
    const tempCli = path.join(
      fs.realpathSync(os.tmpdir()),
      'canary-lab-demo-x', 'demo-project', 'node_modules', 'canary-lab', 'dist', 'apps', 'cli', 'cli.js',
    )

    await setup({ workspace, agent: 'claude', dryRun: false, force: false, implicit: true }, {
      homeDir: home,
      log: (line) => { lines.push(line) },
      execPath: '/usr/bin/node',
      cliPath: tempCli,
      claudeDesktopConfigPath: desktopConfigPath,
      verifyMcp: verifiedStub,
    })

    // Same split as the flag: the workspace is still set up, only the global
    // pointers are left alone — and the reason names the temp dir, not the flag,
    // so the log does not claim an env var the user never set.
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'canary-lab', 'SKILL.md'))).toBe(true)
    expect(lines.join('\n')).toContain('temp directory')
    expect(lines.join('\n')).not.toContain('CANARY_LAB_SKIP_CLIENT_MCP')
    expect(mocks.execFileSync).not.toHaveBeenCalledWith('claude', expect.arrayContaining(['add-json']), expect.anything())
    expect(fs.existsSync(desktopConfigPath)).toBe(false)
  })

  // The getting-started demo prints "cd <temp workspace> && npx canary-lab setup
  // --force" as THE way to drive it from a desktop agent. A user who types that
  // has stated exactly what they want, so the structural guard must not turn the
  // instruction into a silent no-op — the entry registers, with a warning that it
  // dies with the workspace.
  it('registers a client for an explicit setup under the temp dir, and warns the entry rots', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    cliAvailable('claude', home)
    const desktopConfigPath = path.join(mkTmp(), 'Claude', 'claude_desktop_config.json')
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })
    const lines: string[] = []
    const tempCli = path.join(
      fs.realpathSync(os.tmpdir()),
      'canary-lab-demo-x', 'demo-project', 'node_modules', 'canary-lab', 'dist', 'apps', 'cli', 'cli.js',
    )

    await setup({ workspace, agent: 'claude', dryRun: false, force: true }, {
      homeDir: home,
      log: (line) => { lines.push(line) },
      execPath: '/usr/bin/node',
      cliPath: tempCli,
      claudeDesktopConfigPath: desktopConfigPath,
      verifyMcp: verifiedStub,
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      claudeAddJsonArgs('/usr/bin/node', tempCli),
      { stdio: 'ignore' },
    )
    const desktop = JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8')).mcpServers['Canary_Lab']
    expect(desktop.args[0]).toBe(tempCli)
    // The pin is what routes a Desktop session to THIS demo workspace.
    expect(desktop.env.CANARY_LAB_PROJECT_ROOT).toBe(workspace)
    expect(lines.join('\n')).toContain('dies with it')
  })

  // Implicit + durable: a normal `init` in a real folder must still register —
  // the guard keys on the temp path, not on who called setup.
  it('registers a client for an implicit setup outside the temp dir', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    cliAvailable('claude', home)
    const desktopConfigPath = path.join(mkTmp(), 'Claude', 'claude_desktop_config.json')
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })

    await setup({ workspace, agent: 'claude', dryRun: false, force: false, implicit: true }, {
      homeDir: home,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/apps/cli/cli.js',
      claudeDesktopConfigPath: desktopConfigPath,
      verifyMcp: verifiedStub,
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith('claude', expect.arrayContaining(['add-json']), expect.anything())
    expect(fs.existsSync(desktopConfigPath)).toBe(true)
  })

  // Negative control for the guard above: a DURABLE install must still register,
  // which is the supported way to move these pointers.
  it('still registers a client for an install outside the temp dir', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    cliAvailable('claude', home)
    const desktopConfigPath = path.join(mkTmp(), 'Claude', 'claude_desktop_config.json')
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })

    await setup({ workspace, agent: 'claude', dryRun: false, force: false }, {
      homeDir: home,
      log: () => {},
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/apps/cli/cli.js',
      claudeDesktopConfigPath: desktopConfigPath,
      verifyMcp: verifiedStub,
    })

    expect(mocks.execFileSync).toHaveBeenCalledWith('claude', expect.arrayContaining(['add-json']), expect.anything())
  })

  it('verifies the saved registration and rejects a broken command', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    cliAvailable('codex', home)
    const lines: string[] = []
    const seen: string[] = []

    await expect(setup({ workspace, agent: 'codex', dryRun: false, force: false }, {
      homeDir: home,
      log: (line) => lines.push(line),
      execPath: '/usr/bin/node',
      cliPath: '/opt/canary-lab/dist/scripts/cli.js',
      verifyMcp: (invocation) => {
        seen.push(invocation.command)
        return { status: 'broken', message: 'version mismatch' }
      },
    })).rejects.toThrow('version mismatch')

    expect(seen).toEqual(['/usr/bin/node'])
    expect(lines.join('\n')).toContain('Codex MCP verification failed')
  })

  it('dry-run does not write the registry or integrations', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })

    await setup({ workspace, agent: 'auto', dryRun: true, force: false }, {
      homeDir: home,
      log: () => {},
    })

    expect(readWorkspaceRegistry(home).workspaces).toHaveLength(0)
    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'canary-lab'))).toBe(false)
  })

  it('dry-run prints MCP registration intent without add/remove calls', async () => {
    const home = mkTmp()
    const workspace = mkWorkspace()
    const lines: string[] = []
    cliAvailable('codex', home)

    await setup({ workspace, agent: 'codex', dryRun: true, force: false }, {
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
