import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  registerClaudeDesktopMcp,
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
    expect(cfg.mcpServers['canary-lab'].command).toBe(EXEC)
    expect(cfg.mcpServers['canary-lab'].args).toEqual([CLI, 'mcp', '--profile', 'full'])
    expect(cfg.mcpServers['canary-lab'].env.PATH).toContain('/usr/bin')
    expect(lines).toContain('Claude Desktop MCP configured')
  })

  it('creates the config file when none exists', () => {
    const configPath = tmpConfig()
    registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: () => {} })
    expect(read(configPath).mcpServers['canary-lab'].command).toBe(EXEC)
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
      mcpServers: { 'canary-lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))
    const lines: string[] = []

    registerClaudeDesktopMcp({ configPath, execPath: EXEC, cliPath: CLI, log: (l) => lines.push(l) })

    expect(read(configPath).mcpServers['canary-lab'].command).toBe('npx')
    expect(lines[0]).toContain('already configured differently')
  })

  it('replaces a conflicting entry when forced', () => {
    const configPath = tmpConfig()
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'canary-lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))

    registerClaudeDesktopMcp({ configPath, force: true, execPath: EXEC, cliPath: CLI, log: () => {} })

    expect(read(configPath).mcpServers['canary-lab'].command).toBe(EXEC)
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
    expect(read(configPath).mcpServers['canary-lab']).toEqual({
      command: 'npx',
      args: ['-y', 'canary-lab@latest', 'mcp', '--profile', 'full'],
    })
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
      mcpServers: { 'canary-lab': { command: 'npx', args: ['-y', 'canary-lab', 'mcp'] } },
    }))

    registerClaudeDesktopMcp({ configPath, refreshOnly: true, execPath: EXEC, cliPath: CLI, log: () => {} })

    expect(read(configPath).mcpServers['canary-lab'].command).toBe(EXEC)
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
