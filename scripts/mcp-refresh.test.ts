import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('child_process', () => ({ execFileSync: mocks.execFileSync }))

const { refreshCanaryLabMcp } = await import('./mcp-refresh')

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
      ['mcp', 'add', '--scope', 'user', 'Canary_Lab', '--', EXEC, CLI, 'mcp', '--profile', 'lifecycle'],
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
      ['mcp', 'add', '--scope', 'user', 'Canary_Lab', '--', EXEC, CLI, 'mcp', '--profile', 'lifecycle'],
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
