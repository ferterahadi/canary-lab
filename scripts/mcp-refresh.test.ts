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

beforeEach(() => mocks.execFileSync.mockReset())
afterEach(() => {
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
      if (cmd === 'claude' && args.join(' ') === 'mcp get canary-lab') {
        return opts?.encoding === 'utf-8'
          ? 'canary-lab:\n  Type: stdio\n  Command: npx\n  Args: -y canary-lab mcp\n'
          : Buffer.from('')
      }
      return Buffer.from('')
    })
    const desktopConfigPath = tmpConfig()
    fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true })
    fs.writeFileSync(desktopConfigPath, JSON.stringify({
      mcpServers: { 'canary-lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))

    refreshCanaryLabMcp({ execPath: EXEC, cliPath: CLI, claudeDesktopConfigPath: desktopConfigPath, log: () => {} })

    expect(mocks.execFileSync).not.toHaveBeenCalledWith('codex', expect.arrayContaining(['add']), expect.anything())
    expect(mocks.execFileSync).toHaveBeenCalledWith('claude', ['mcp', 'remove', 'canary-lab', '-s', 'user'], { stdio: 'ignore' })
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'claude',
      ['mcp', 'add', '--scope', 'user', 'canary-lab', '--', EXEC, CLI, 'mcp', '--profile', 'full'],
      { stdio: 'ignore' },
    )
    expect(JSON.parse(fs.readFileSync(desktopConfigPath, 'utf-8')).mcpServers['canary-lab'].command).toBe(EXEC)
  })

  it('does not touch Claude Desktop when its config directory is absent', () => {
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    mocks.execFileSync.mockImplementation((cmd: string, args: string[] = []) => {
      if (cmd === lookup) return Buffer.from('')
      if (args.join(' ') === 'mcp get canary-lab') throw new Error('missing MCP server')
      return Buffer.from('')
    })
    const desktopConfigPath = tmpConfig()

    refreshCanaryLabMcp({ execPath: EXEC, cliPath: CLI, claudeDesktopConfigPath: desktopConfigPath, log: () => {} })

    expect(fs.existsSync(desktopConfigPath)).toBe(false)
  })
})
