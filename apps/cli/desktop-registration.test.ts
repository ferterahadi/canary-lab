import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  registerClaudeDesktopMcp,
  registeredDesktopCliPath,
  claudeDesktopConfigPath,
  claudeDesktopInstalled,
} from './desktop-registration'

const tmpDirs: string[] = []
function tmpConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-desktop-'))
  tmpDirs.push(dir)
  return path.join(dir, 'Claude', 'claude_desktop_config.json')
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const EXEC = '/usr/bin/node'
const CLI = '/opt/canary-lab/dist/scripts/cli.js'
const EPHEMERAL_CLI = '/Users/x/.npm/_npx/abc/node_modules/canary-lab/dist/scripts/cli.js'

function read(configPath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
}

describe('claudeDesktopConfigPath', () => {
  it('resolves the macOS Application Support path', () => {
    expect(claudeDesktopConfigPath('/Users/x', 'darwin')).toBe(
      '/Users/x/Library/Application Support/Claude/claude_desktop_config.json',
    )
  })
})

describe('registerClaudeDesktopMcp', () => {
  it('adds the canary-lab server with a PATH env, preserving existing keys', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ preferences: { a: 1 }, coworkUserFilesPath: '/x' }))
    const lines: string[] = []

    registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: (l) => lines.push(l) })

    const cfg = read(configPath)
    expect(cfg.preferences).toEqual({ a: 1 })
    expect(cfg.coworkUserFilesPath).toBe('/x')
    expect(cfg.mcpServers['Canary_Lab'].command).toBe(EXEC)
    expect(cfg.mcpServers['Canary_Lab'].args).toEqual([CLI, 'mcp', '--profile', 'compact'])
    expect(cfg.mcpServers['Canary_Lab'].alwaysLoad).toBe(true)
    expect(cfg.mcpServers['Canary_Lab'].env.PATH).toContain('/usr/bin')
    expect(lines).toContain('Claude Desktop MCP configured')
  })

  it('creates the config file when none exists', () => {
    const configPath = tmpConfig()
    registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: () => {} })
    expect(read(configPath).mcpServers['Canary_Lab'].command).toBe(EXEC)
  })

  it('is idempotent when the entry already matches', () => {
    const configPath = tmpConfig()
    const lines: string[] = []
    registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: () => {} })
    registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: (l) => lines.push(l) })
    expect(lines).toEqual(['Claude Desktop MCP already configured'])
  })

  it('warns on a conflicting entry unless forced', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'Canary_Lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))
    const lines: string[] = []

    registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: (l) => lines.push(l) })

    expect(read(configPath).mcpServers['Canary_Lab'].command).toBe('npx')
    expect(lines[0]).toContain('already configured differently')
  })

  it('replaces a conflicting entry when forced', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'Canary_Lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))

    registerClaudeDesktopMcp({ configPath, force: true, execPath: EXEC, cliPath: CLI, log: () => {} })

    expect(read(configPath).mcpServers['Canary_Lab'].command).toBe(EXEC)
  })

  it('dry-run does not write the file', () => {
    const configPath = tmpConfig()
    const lines: string[] = []
    registerClaudeDesktopMcp({ configPath, dryRun: true, execPath: EXEC, cliPath: CLI, log: (l) => lines.push(l) })
    expect(fs.existsSync(configPath)).toBe(false)
    expect(lines[0]).toContain('[dry-run]')
  })

  it('uses the npx@latest form without env for an ephemeral install', () => {
    const configPath = tmpConfig()
    registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: EPHEMERAL_CLI, log: () => {} })
    expect(read(configPath).mcpServers['Canary_Lab']).toEqual({
      command: 'npx',
      args: ['-y', 'canary-lab@latest', 'mcp', '--profile', 'compact'],
      alwaysLoad: true,
    })
  })
})

describe('registerClaudeDesktopMcp workspace pin', () => {
  // Desktop is a GUI: it has no cwd, so the bridge cannot infer which workspace
  // it belongs to. Without the pin, a Desktop session had to hope the right
  // server happened to be the one discovery picked.
  it('pins the workspace as CANARY_LAB_PROJECT_ROOT', () => {
    const configPath = tmpConfig()
    registerClaudeDesktopMcp({
      configPath, execPath: EXEC, cliPath: CLI, projectRoot: '/work/durable', log: () => {},
    })
    expect(read(configPath).mcpServers.Canary_Lab.env).toEqual({
      PATH: expect.any(String),
      CANARY_LAB_PROJECT_ROOT: '/work/durable',
    })
  })

  it('omits the pin when no workspace is given', () => {
    const configPath = tmpConfig()
    registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: () => {} })
    expect(read(configPath).mcpServers.Canary_Lab.env.CANARY_LAB_PROJECT_ROOT).toBeUndefined()
  })

  // The whole point of comparing the pin: an entry aimed at a workspace that is
  // gone must read as stale, not as "already configured".
  it('re-points an entry pinned to a different workspace', () => {
    const configPath = tmpConfig()
    registerClaudeDesktopMcp({
      configPath, execPath: EXEC, cliPath: CLI, projectRoot: '/work/old', log: () => {},
    })
    const result = registerClaudeDesktopMcp({
      configPath, execPath: EXEC, cliPath: CLI, projectRoot: '/work/new', refreshOnly: true, log: () => {},
    })
    expect(result).toBe('configured')
    expect(read(configPath).mcpServers.Canary_Lab.env.CANARY_LAB_PROJECT_ROOT).toBe('/work/new')
  })

  it('leaves an entry already pinned to the same workspace alone', () => {
    const configPath = tmpConfig()
    const args = { configPath, execPath: EXEC, cliPath: CLI, projectRoot: '/work/same', log: () => {} }
    registerClaudeDesktopMcp(args)
    expect(registerClaudeDesktopMcp(args)).toBe('unchanged')
  })
})

describe('registerClaudeDesktopMcp refresh', () => {
  it('skips writing when no canary-lab entry exists', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({ preferences: { a: 1 } }))

    registerClaudeDesktopMcp({ configPath, refreshOnly: true, execPath: EXEC, cliPath: CLI, log: () => {} })

    const cfg = read(configPath)
    expect(cfg.mcpServers).toBeUndefined()
  })

  it('replaces a stale entry without an explicit force flag', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'Canary_Lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))

    registerClaudeDesktopMcp({ configPath, refreshOnly: true, execPath: EXEC, cliPath: CLI, log: () => {} })

    expect(read(configPath).mcpServers['Canary_Lab'].command).toBe(EXEC)
  })

  it('migrates a legacy canary-lab entry to Canary_Lab', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'canary-lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))
    const lines: string[] = []

    registerClaudeDesktopMcp({ configPath, refreshOnly: true, execPath: EXEC, cliPath: CLI, log: (l) => lines.push(l) })

    const cfg = read(configPath)
    expect(cfg.mcpServers['canary-lab']).toBeUndefined()
    expect(cfg.mcpServers['Canary_Lab'].command).toBe(EXEC)
    expect(lines.join('\n')).toContain('migrated legacy entry')
  })
})

// Desktop is the only client with no `mcp get` CLI, so the stale-path check can
// reach it only through this reader — see findStaleCanaryLabMcp in mcp-refresh.
describe('registeredDesktopCliPath', () => {
  it('reads back the cli.js path Desktop is configured to launch', () => {
    const configPath = tmpConfig()
    registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: () => {} })

    expect(registeredDesktopCliPath(configPath)).toBe(CLI)
  })

  it('is null when the config file does not exist', () => {
    expect(registeredDesktopCliPath(tmpConfig())).toBeNull()
  })

  it.each([
    ['no mcpServers key', { preferences: { a: 1 } }],
    ['mcpServers not an object', { mcpServers: 'nope' }],
    ['no Canary Lab entry', { mcpServers: { Other: { command: 'x', args: ['/o/cli.js'] } } }],
    ['entry is not an object', { mcpServers: { 'Canary_Lab': 'nope' } }],
    ['entry has no args array', { mcpServers: { 'Canary_Lab': { command: 'node' } } }],
    ['args carry no cli.js', { mcpServers: { 'Canary_Lab': { command: 'node', args: ['--version'] } } }],
  ])('is null when %s', (_label, contents) => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(contents))

    expect(registeredDesktopCliPath(configPath)).toBeNull()
  })

  it('is null for the npx@latest form, which pins no path that can rot', () => {
    const configPath = tmpConfig()
    registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: EPHEMERAL_CLI, log: () => {} })

    expect(registeredDesktopCliPath(configPath)).toBeNull()
  })
})

// The `ui` boot re-point reports a repair to the user and stays silent
// otherwise, so these three outcomes have to be distinguishable by return value
// — the log lines alone cannot drive that decision.
describe('registerClaudeDesktopMcp result', () => {
  const write = (configPath: string, contents: unknown): void => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(contents))
  }

  it('reports configured on a real write, then unchanged on a repeat', () => {
    const configPath = tmpConfig()

    expect(registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: () => {} })).toBe('configured')
    expect(registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: () => {} })).toBe('unchanged')
  })

  it('reports configured when a stale entry is healed under refreshOnly', () => {
    const configPath = tmpConfig()
    write(configPath, { mcpServers: { 'Canary_Lab': { command: EXEC, args: ['/old/dist/scripts/cli.js', 'mcp'] } } })

    expect(registerClaudeDesktopMcp({ configPath, refreshOnly: true, execPath: EXEC, cliPath: CLI, log: () => {} }))
      .toBe('configured')
  })

  it('reports configured when only a legacy key had to be migrated', () => {
    const configPath = tmpConfig()
    const entry = {
      command: EXEC,
      args: [CLI, 'mcp', '--profile', 'compact'],
      env: { PATH: '/usr/bin:/bin' },
      alwaysLoad: true,
    }
    // New key already correct; the legacy duplicate is the only thing to remove.
    write(configPath, { mcpServers: { 'canary-lab': { command: 'npx', args: [] }, 'Canary_Lab': entry } })

    expect(registerClaudeDesktopMcp({
      configPath, refreshOnly: true, execPath: EXEC, cliPath: CLI, pathEnv: '/usr/bin:/bin', log: () => {},
    })).toBe('configured')
  })

  it('reports skipped for a dry run', () => {
    expect(registerClaudeDesktopMcp({ configPath: tmpConfig(), dryRun: true, execPath: EXEC, cliPath: CLI, log: () => {} }))
      .toBe('skipped')
  })

  it('reports skipped when refreshOnly finds nothing to re-point', () => {
    const configPath = tmpConfig()
    write(configPath, { preferences: { a: 1 } })

    expect(registerClaudeDesktopMcp({ configPath, refreshOnly: true, execPath: EXEC, cliPath: CLI, log: () => {} }))
      .toBe('skipped')
  })

  it('reports skipped on a conflict with neither force nor refreshOnly', () => {
    const configPath = tmpConfig()
    write(configPath, { mcpServers: { 'Canary_Lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } } })

    expect(registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: () => {} })).toBe('skipped')
  })
})

describe('claudeDesktopInstalled', () => {
  it('is true when the Claude support dir exists', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    expect(claudeDesktopInstalled(configPath)).toBe(true)
  })

  it('is false when the support dir is absent', () => {
    expect(claudeDesktopInstalled(tmpConfig())).toBe(false)
  })
})
