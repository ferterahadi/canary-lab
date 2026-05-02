import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildAgentCommand, buildClaudeMcpConfigArg, buildOrchestratorHealCommand, pickAvailableHealAgent } from './auto-heal'

describe('buildClaudeMcpConfigArg', () => {
  it('writes the MCP config to disk and returns `--mcp-config "<file>"`', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-')))
    try {
      const cfgPath = path.join(tmp, 'mcp-config.json')
      const arg = buildClaudeMcpConfigArg('/tmp/run-1/failed/foo/playwright-mcp', cfgPath)
      // Returned arg references the FILE PATH (not inline JSON) so claude's
      // `open()`-then-fallback path doesn't trip ENAMETOOLONG.
      expect(arg).toBe(`--mcp-config ${JSON.stringify(cfgPath)}`)
      // File contents are valid JSON wiring @playwright/mcp + --output-dir.
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
      expect(written.mcpServers.playwright.command).toBe('npx')
      expect(written.mcpServers.playwright.args).toContain('@playwright/mcp@latest')
      expect(written.mcpServers.playwright.args).toContain('--output-dir')
      expect(written.mcpServers.playwright.args).toContain('/tmp/run-1/failed/foo/playwright-mcp')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('buildAgentCommand wires MCP config when outputDir given', () => {
  it('claude path: writes the MCP config next to the prompt file and references the path', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-cmd-')))
    try {
      const promptFile = path.join(tmp, 'prompt.md')
      fs.writeFileSync(promptFile, 'noop')
      const cmd = buildAgentCommand('claude', 'new', 0, promptFile, '/tmp/out')
      const cfgPath = path.join(tmp, 'mcp-config.json')
      // Inline JSON would have shown up in the command; the path form does not.
      expect(cmd).not.toMatch(/--mcp-config ['"]?\{/)
      expect(cmd).toContain(`--mcp-config ${JSON.stringify(cfgPath)}`)
      // And the file actually exists with the expected `--output-dir` arg.
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
      expect(written.mcpServers.playwright.args).toContain('/tmp/out')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('claude path omits --mcp-config when outputDir is missing', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-no-')))
    try {
      const promptFile = path.join(tmp, 'prompt.md')
      fs.writeFileSync(promptFile, 'noop')
      const cmd = buildAgentCommand('claude', 'new', 0, promptFile)
      expect(cmd.includes('--mcp-config')).toBe(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('codex path is unaffected by outputDir', () => {
    const cmd = buildAgentCommand('codex', 'new', 0, '/tmp/p.txt', '/tmp/out')
    expect(cmd.includes('--mcp-config')).toBe(false)
  })

  it('claude path: `-p` is the LAST flag so the variadic --mcp-config does not slurp the prompt', () => {
    // Regression: when `--mcp-config` came AFTER `-p`, claude treated the
    // prompt's `$(cat ...)` arg as another config file and tripped
    // ENAMETOOLONG. Lock the ordering so this doesn't drift.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-order-')))
    try {
      const promptFile = path.join(tmp, 'prompt.md')
      fs.writeFileSync(promptFile, 'noop')
      const cmd = buildAgentCommand('claude', 'new', 0, promptFile, '/tmp/out')
      const mcpIdx = cmd.indexOf('--mcp-config')
      const pIdx = cmd.indexOf(' -p ')
      expect(mcpIdx).toBeGreaterThan(0)
      expect(pIdx).toBeGreaterThan(0)
      expect(mcpIdx).toBeLessThan(pIdx)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('pickAvailableHealAgent', () => {
  it('returns null when env override names a missing CLI', () => {
    expect(pickAvailableHealAgent('definitely-not-a-real-cli-xyz' as never)).toBe(null)
  })

  it('returns null when override is unrelated to claude/codex', () => {
    expect(pickAvailableHealAgent('something-else')).toBe(null)
  })
  // We deliberately don't assert "claude is preferred" because the result
  // depends on what's installed on the host running the test. The contract
  // is covered by isAgentCliAvailable + the explicit override branches.
})

describe('buildOrchestratorHealCommand', () => {
  let tmp: string
  let runDir: string
  let projectRoot: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-')))
    runDir = path.join(tmp, 'run')
    projectRoot = path.join(tmp, 'project')
    fs.mkdirSync(runDir, { recursive: true })
    fs.mkdirSync(projectRoot, { recursive: true })
    // Plant a CLAUDE.md with the heal-prompt block so loadPrompt succeeds.
    fs.writeFileSync(
      path.join(projectRoot, 'CLAUDE.md'),
      `before\n<!-- heal-prompt:start -->\nFix the failing tests.\n<!-- heal-prompt:end -->\nafter`,
    )
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('throws synchronously when prompt file is missing (caller can degrade)', () => {
    expect(() => buildOrchestratorHealCommand({
      agent: 'claude',
      projectRoot: '/no/such/dir',
      runDir,
    })).toThrow(/Heal prompt source not found/)
  })

  it('throws synchronously when prompt markers are missing', () => {
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'no markers here')
    expect(() => buildOrchestratorHealCommand({
      agent: 'claude',
      projectRoot,
      runDir,
    })).toThrow(/Heal prompt markers/)
  })

  it('returns a buildCommand that writes the prompt and includes claude flags', () => {
    const build = buildOrchestratorHealCommand({ agent: 'claude', projectRoot, runDir })
    const cmd = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    // Prompt file was written under runDir.
    const promptPath = path.join(runDir, 'heal-prompt.md')
    expect(fs.existsSync(promptPath)).toBe(true)
    const promptBody = fs.readFileSync(promptPath, 'utf-8')
    expect(promptBody).toContain('Fix the failing tests.')
    // Command starts with the claude CLI invocation and embeds the prompt path.
    expect(cmd).toMatch(/^claude /)
    expect(cmd).toContain(JSON.stringify(promptPath))
  })

  it('uses --continue on cycle > 0 when sessionMode=resume', () => {
    const build = buildOrchestratorHealCommand({
      agent: 'claude',
      projectRoot,
      runDir,
      sessionMode: 'resume',
    })
    const c0 = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    const c1 = build({ cycle: 1, outputDir: path.join(runDir, 'out') })
    expect(c0.includes('--continue')).toBe(false)
    expect(c1).toContain('--continue')
  })

  it('codex agent: builds the codex CLI command when claude is not requested', () => {
    fs.writeFileSync(
      path.join(projectRoot, 'AGENTS.md'),
      `<!-- heal-prompt:start -->\nFix the failing tests.\n<!-- heal-prompt:end -->`,
    )
    const build = buildOrchestratorHealCommand({ agent: 'codex', projectRoot, runDir })
    const cmd = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(cmd).toContain('codex exec')
    expect(cmd.includes('--mcp-config')).toBe(false) // codex doesn't use claude's mcp flag
  })
})
