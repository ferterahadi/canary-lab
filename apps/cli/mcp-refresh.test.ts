import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('child_process', () => ({ execFileSync: mocks.execFileSync }))

const { refreshCanaryLabMcp, findStaleCanaryLabMcp, refreshClaudeDesktopMcpQuietly } = await import('./mcp-refresh')
const { claudeDesktopConfigPath } = await import('./desktop-registration')

// A throwaway home with a Desktop config already in place, so the per-OS layout
// comes from the resolver rather than a hardcoded macOS path.
function tmpHomeWithDesktopConfig(contents: unknown): { homeDir: string; configPath: string } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-refresh-home-'))
  tmpDirs.push(homeDir)
  const configPath = claudeDesktopConfigPath(homeDir)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(contents))
  return { homeDir, configPath }
}

const tmpDirs: string[] = []
function tmpConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-refresh-'))
  tmpDirs.push(dir)
  return path.join(dir, 'Claude', 'claude_desktop_config.json')
}

beforeEach(() => {
  mocks.execFileSync.mockReset()
  delete process.env.CANARY_LAB_SKIP_CLIENT_MCP
})
afterEach(() => {
  delete process.env.CANARY_LAB_SKIP_CLIENT_MCP
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const EXEC = '/usr/bin/node'
const CLI = '/opt/canary-lab/dist/scripts/cli.js'

describe('refreshCanaryLabMcp', () => {
  it('heals a legacy Claude CLI config and a stale Desktop entry, leaving an absent Codex untouched', () => {
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    mocks.execFileSync.mockImplementation((cmd: string, args: string[], opts?: { encoding?: string }) => {
      if (cmd === lookup && args[0] === 'claude') return Buffer.from('')
      if (cmd === lookup && args[0] === 'codex') throw new Error('missing')
      if (cmd === 'claude' && args[0] === 'mcp' && args[1] === 'get') {
        // Stale entry under the new key; no legacy `canary-lab` entry here.
        if (args[2] === 'Canary_Lab') {
          return opts?.encoding === 'utf-8'
            ? 'Canary_Lab:\n  Type: stdio\n  Command: npx\n  Args: -y canary-lab mcp\n'
            : Buffer.from('')
        }
        throw new Error('missing MCP server')
      }
      return Buffer.from('')
    })
    const desktopConfigPath = tmpConfig()
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })
    fs.writeFileSync(desktopConfigPath, JSON.stringify({
      mcpServers: { 'Canary_Lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))

    refreshCanaryLabMcp({ execPath: EXEC, cliPath: CLI, claudeDesktopConfigPath: desktopConfigPath, log: () => {} })

    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
    expect(mocks.execFileSync).toHaveBeenCalledWith('claude', ['mcp', 'remove', 'Canary_Lab', '-s', 'user'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      ['mcp', 'add', '--scope', 'user', 'Canary_Lab', '--', EXEC, CLI, 'mcp', '--profile', 'full'],
      { stdio: 'ignore' },
    )
    expect(JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8')).mcpServers['Canary_Lab'].command).toBe(EXEC)
  })

  it('migrates legacy canary-lab entries to Canary_Lab on upgrade (CLI + Desktop)', () => {
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    mocks.execFileSync.mockImplementation((cmd: string, args: string[] = []) => {
      if (cmd === lookup && args[0] === 'claude') return Buffer.from('')
      if (cmd === lookup && args[0] === 'codex') throw new Error('missing')
      if (cmd === 'claude' && args[0] === 'mcp' && args[1] === 'get') {
        // Only the legacy key exists; the new key is absent.
        if (args[2] === 'canary-lab') return Buffer.from('present')
        throw new Error('missing MCP server')
      }
      return Buffer.from('')
    })
    const desktopConfigPath = tmpConfig()
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })
    fs.writeFileSync(desktopConfigPath, JSON.stringify({
      mcpServers: { 'canary-lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))

    refreshCanaryLabMcp({ execPath: EXEC, cliPath: CLI, claudeDesktopConfigPath: desktopConfigPath, log: () => {} })

    // CLI: legacy entry removed, new key added — no manual `mcp remove` needed.
    expect(mocks.execFileSync).toHaveBeenCalledWith('claude', ['mcp', 'remove', 'canary-lab', '-s', 'user'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      ['mcp', 'add', '--scope', 'user', 'Canary_Lab', '--', EXEC, CLI, 'mcp', '--profile', 'full'],
      { stdio: 'ignore' },
    )
    // Desktop: legacy key gone, new key written.
    const cfg = JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8'))
    expect(cfg.mcpServers['canary-lab']).toBeUndefined()
    expect(cfg.mcpServers['Canary_Lab'].command).toBe(EXEC)
  })

  it('CANARY_LAB_SKIP_CLIENT_MCP short-circuits before touching any client', () => {
    process.env.CANARY_LAB_SKIP_CLIENT_MCP = '1'
    const desktopConfigPath = tmpConfig()
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })
    fs.writeFileSync(desktopConfigPath, JSON.stringify({
      mcpServers: { 'Canary_Lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))
    const lines: string[] = []

    refreshCanaryLabMcp({ execPath: EXEC, cliPath: CLI, claudeDesktopConfigPath: desktopConfigPath, log: (l) => lines.push(l) })

    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('Skipping client MCP refresh')
    // The pre-existing Desktop entry is left exactly as it was.
    expect(JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8')).mcpServers['Canary_Lab'].command).toBe('npx')
  })

  it('does not touch Claude Desktop when its config directory is absent', () => {
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    mocks.execFileSync.mockImplementation((cmd: string, args: string[] = []) => {
      if (cmd === lookup) return Buffer.from('')
      if (args[0] === 'mcp' && args[1] === 'get') throw new Error('missing MCP server')
      return Buffer.from('')
    })
    const desktopConfigPath = tmpConfig()

    refreshCanaryLabMcp({ execPath: EXEC, cliPath: CLI, claudeDesktopConfigPath: desktopConfigPath, log: () => {} })

    expect(fs.existsSync(desktopConfigPath)).toBe(false)
  })
})

describe('findStaleCanaryLabMcp', () => {
  // The point of this check: every failure path in the refresh is quiet, so the
  // only reliable signal that a client is broken is the registered path itself
  // no longer existing on disk.
  it('reports a client whose registered cli.js was deleted by an upgrade', () => {
    const stale = findStaleCanaryLabMcp({
      readRegisteredCliPath: (target) =>
        target === 'claude' ? '/old/dist/scripts/cli.js' : null,
      readDesktopCliPath: () => null,
      exists: () => false,
    })

    expect(stale).toEqual([{ client: 'Claude', cliPath: '/old/dist/scripts/cli.js' }])
  })

  it('reports both CLI clients independently', () => {
    const stale = findStaleCanaryLabMcp({
      readRegisteredCliPath: () => '/gone/cli.js',
      readDesktopCliPath: () => null,
      exists: () => false,
    })

    expect(stale.map((s) => s.client)).toEqual(['Codex', 'Claude'])
  })

  it('stays quiet when the registered path still resolves', () => {
    expect(findStaleCanaryLabMcp({
      readRegisteredCliPath: () => '/live/dist/apps/cli/cli.js',
      readDesktopCliPath: () => null,
      exists: () => true,
    })).toEqual([])
  })

  it('stays quiet when a client has no Canary Lab entry at all', () => {
    const exists = vi.fn(() => false)

    expect(findStaleCanaryLabMcp({
      readRegisteredCliPath: () => null,
      readDesktopCliPath: () => null,
      exists,
    })).toEqual([])
    expect(exists).not.toHaveBeenCalled()
  })

  // Desktop is the client most likely to go stale — it rewrites its own config
  // from a pre-upgrade copy — and the one the check used to be blind to.
  it('reports Claude Desktop, which has no client CLI to query', () => {
    const stale = findStaleCanaryLabMcp({
      readRegisteredCliPath: () => null,
      readDesktopCliPath: () => '/old/dist/scripts/cli.js',
      exists: () => false,
    })

    expect(stale).toEqual([{ client: 'Claude Desktop', cliPath: '/old/dist/scripts/cli.js' }])
  })

  it('reports Desktop alongside the CLI clients rather than instead of them', () => {
    const stale = findStaleCanaryLabMcp({
      readRegisteredCliPath: () => '/gone/cli.js',
      readDesktopCliPath: () => '/gone/desktop/cli.js',
      exists: () => false,
    })

    expect(stale.map((s) => s.client)).toEqual(['Codex', 'Claude', 'Claude Desktop'])
  })

  // The refresh writes Desktop under this home, so the check has to read the
  // same one — otherwise a smoke-test upgrade warns about the real install.
  it('reads the Desktop config under homeDir, through the real reader', () => {
    const { homeDir } = tmpHomeWithDesktopConfig({
      mcpServers: { 'Canary_Lab': { command: EXEC, args: ['/gone/dist/scripts/cli.js', 'mcp'] } },
    })

    const stale = findStaleCanaryLabMcp({ readRegisteredCliPath: () => null, homeDir })

    expect(stale).toEqual([{ client: 'Claude Desktop', cliPath: '/gone/dist/scripts/cli.js' }])
  })

  it('stays quiet when Desktop points at a path that still resolves', () => {
    expect(findStaleCanaryLabMcp({
      readRegisteredCliPath: () => null,
      readDesktopCliPath: () => '/live/dist/apps/cli/cli.js',
      exists: () => true,
    })).toEqual([])
  })
})

// Why this exists at all: `upgrade` already heals Desktop, but Desktop owns its
// config file and rewrites it wholesale from a copy loaded at launch — so an
// instance running across the upgrade puts the dead path back afterwards.
// Re-asserting at `ui` boot is the only touchpoint later than the revert.
describe('refreshClaudeDesktopMcpQuietly', () => {
  it('re-points an entry Desktop reverted to a pre-upgrade path, and says it repaired it', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'Canary_Lab': { command: EXEC, args: ['/old/dist/scripts/cli.js', 'mcp', '--profile', 'lifecycle'] } },
    }))

    const result = refreshClaudeDesktopMcpQuietly({ configPath, execPath: EXEC, cliPath: CLI })

    expect(result).toBe('configured')
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers['Canary_Lab'].args[0]).toBe(CLI)
  })

  it('reports unchanged on the next boot, so the caller stays silent', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'Canary_Lab': { command: EXEC, args: ['/old/dist/scripts/cli.js', 'mcp'] } },
    }))
    // First boot heals it; the entry it wrote is the one a healthy boot re-reads.
    expect(refreshClaudeDesktopMcpQuietly({ configPath, execPath: EXEC, cliPath: CLI })).toBe('configured')

    expect(refreshClaudeDesktopMcpQuietly({ configPath, execPath: EXEC, cliPath: CLI })).toBe('unchanged')
  })

  // The boot re-point must carry the booting workspace, or it would strip a pin
  // `setup` had just written — the two writers would fight on every `ui` start.
  it('pins the booting workspace on the entry it re-points', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'Canary_Lab': { command: EXEC, args: ['/old/dist/scripts/cli.js', 'mcp'] } },
    }))

    const result = refreshClaudeDesktopMcpQuietly({
      configPath, execPath: EXEC, cliPath: CLI, projectRoot: '/work/booting',
    })

    expect(result).toBe('configured')
    const entry = JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers['Canary_Lab']
    expect(entry.env.CANARY_LAB_PROJECT_ROOT).toBe('/work/booting')
  })

  it('never adds an entry to a Desktop that was never configured', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ preferences: { a: 1 } }))

    expect(refreshClaudeDesktopMcpQuietly({ configPath, execPath: EXEC, cliPath: CLI })).toBe('skipped')
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers).toBeUndefined()
  })

  it('does nothing when Claude Desktop is not installed', () => {
    const configPath = tmpConfig()

    expect(refreshClaudeDesktopMcpQuietly({ configPath, execPath: EXEC, cliPath: CLI })).toBe('skipped')
    expect(fs.existsSync(configPath)).toBe(false)
  })

  it('honours CANARY_LAB_SKIP_CLIENT_MCP so a smoke-test install cannot hijack the real config', () => {
    process.env.CANARY_LAB_SKIP_CLIENT_MCP = '1'
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'Canary_Lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))

    expect(refreshClaudeDesktopMcpQuietly({ configPath, execPath: EXEC, cliPath: CLI })).toBe('skipped')
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers['Canary_Lab'].command).toBe('npx')
  })

  it('resolves the config under CANARY_LAB_AGENT_HOME, keeping tests off the real Desktop config', () => {
    const { homeDir, configPath } = tmpHomeWithDesktopConfig({
      mcpServers: { 'Canary_Lab': { command: EXEC, args: ['/old/dist/scripts/cli.js', 'mcp'] } },
    })
    const priorHome = process.env.CANARY_LAB_AGENT_HOME
    process.env.CANARY_LAB_AGENT_HOME = homeDir

    try {
      expect(refreshClaudeDesktopMcpQuietly({ execPath: EXEC, cliPath: CLI })).toBe('configured')
    } finally {
      if (priorHome === undefined) delete process.env.CANARY_LAB_AGENT_HOME
      else process.env.CANARY_LAB_AGENT_HOME = priorHome
    }

    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers['Canary_Lab'].args[0]).toBe(CLI)
  })

  // Running as root defeats the read-only bit, so this asserts the guarantee
  // only where the OS can actually enforce it.
  const cannotChmod = process.platform === 'win32' || process.getuid?.() === 0
  it.skipIf(cannotChmod)('swallows a write failure rather than blocking the ui boot', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'Canary_Lab': { command: EXEC, args: ['/old/dist/scripts/cli.js', 'mcp'] } },
    }))
    // Stale entry, so the refresh definitely tries to write — and cannot.
    fs.chmodSync(configPath, 0o444)

    expect(refreshClaudeDesktopMcpQuietly({ configPath, execPath: EXEC, cliPath: CLI })).toBe('skipped')
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers['Canary_Lab'].args[0])
      .toBe('/old/dist/scripts/cli.js')
  })
})

// The gap CANARY_LAB_SKIP_CLIENT_MCP left open: that env var only protects harnesses
// that remember to set it. An interactive `canary-lab ui` inside the getting-started
// demo's temp workspace set nothing, and repointed the user's real client config at a
// path that dies on the next temp sweep.
describe('temp-install guard', () => {
  const TEMP_CLI = path.join(os.tmpdir(), 'canary-lab-demo-abc', 'demo-project', 'node_modules', 'canary-lab', 'dist', 'apps', 'cli', 'cli.js')

  it('refreshCanaryLabMcp writes nothing when the install is under the temp dir', () => {
    const messages: string[] = []
    refreshCanaryLabMcp({ execPath: EXEC, cliPath: TEMP_CLI, log: (m) => messages.push(m) })
    // Not "no add" — NO client process at all. A `which`/`get` probe would mean the
    // guard sits below the detection it is supposed to short-circuit.
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(messages.join(' ')).toContain('temp directory')
  })

  it('refreshClaudeDesktopMcpQuietly skips when the install is under the temp dir', () => {
    const desktopConfigPath = tmpConfig()
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })
    fs.writeFileSync(desktopConfigPath, JSON.stringify({ mcpServers: {} }))
    const before = fs.readFileSync(desktopConfigPath, 'utf-8')

    expect(refreshClaudeDesktopMcpQuietly({ execPath: EXEC, cliPath: TEMP_CLI, configPath: desktopConfigPath })).toBe('skipped')
    expect(fs.readFileSync(desktopConfigPath, 'utf-8')).toBe(before)
  })

  it('still refreshes a durable install', () => {
    // claudeDesktopConfigPath MUST be overridden: execFileSync is mocked but fs
    // is real, so without it the Desktop branch resolves the developer's actual
    // claude_desktop_config.json and overwrites it with these fixtures.
    refreshCanaryLabMcp({ execPath: EXEC, cliPath: CLI, claudeDesktopConfigPath: tmpConfig(), log: () => {} })
    expect(mocks.execFileSync).toHaveBeenCalled()
  })
})
