import { describe, it, expect } from 'vitest'
import { buildAgentCommand, buildClaudeMcpConfigArg } from './auto-heal'

describe('buildClaudeMcpConfigArg', () => {
  it('produces a single-line --mcp-config argument with --output-dir', () => {
    const arg = buildClaudeMcpConfigArg('/tmp/run-1/failed/foo/playwright-mcp')
    expect(arg.startsWith('--mcp-config ')).toBe(true)
    // The shell-quoted JSON includes the --output-dir token.
    expect(arg).toContain('--output-dir')
    expect(arg).toContain('/tmp/run-1/failed/foo/playwright-mcp')
    expect(arg).toContain('@playwright/mcp@latest')
  })
})

describe('buildAgentCommand wires MCP config when outputDir given', () => {
  it('claude path includes --mcp-config when outputDir is provided', () => {
    const cmd = buildAgentCommand('claude', 'new', 0, '/tmp/p.txt', '/tmp/out')
    expect(cmd).toContain('--mcp-config')
    expect(cmd).toContain('/tmp/out')
  })

  it('claude path omits --mcp-config when outputDir is missing', () => {
    const cmd = buildAgentCommand('claude', 'new', 0, '/tmp/p.txt')
    expect(cmd.includes('--mcp-config')).toBe(false)
  })

  it('codex path is unaffected by outputDir', () => {
    const cmd = buildAgentCommand('codex', 'new', 0, '/tmp/p.txt', '/tmp/out')
    expect(cmd.includes('--mcp-config')).toBe(false)
  })
})
