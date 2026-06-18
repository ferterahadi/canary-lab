import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildAgentSpawnCommand,
  buildClaudeMcpConfigArg,
  buildHealPromptMap,
  buildOrchestratorHealPrompt,
  isAgentCliAvailable,
  pickAvailableHealAgent,
  readPriorSessionId,
  readPriorSessionIdFromValue,
  renderPlaywrightMcpHint,
  renderTraceExtractHint,
  resolveAgentBinary,
  type AgentResolveDeps,
} from './auto-heal'

import { renderPersonalWikiMap } from '../../../../shared/runtime/personal-wiki'
import { HEAL_MODELS } from '../agent-models'

function writeRunManifest(runDir: string, body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    runId: 'r1',
    feature: 'f',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'running',
    healCycles: 0,
    services: [],
    ...body,
  }))
}

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

describe('buildAgentSpawnCommand', () => {
  it('claude REPL: pins --session-id and wires MCP, but does NOT bypass permissions', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-spawn-')))
    try {
      const cfgPath = path.join(tmp, 'mcp-config.json')
      const cmd = buildAgentSpawnCommand('claude', {
        sessionId: 'abc-123',
        mcpOutputDir: '/tmp/out',
        mcpConfigFile: cfgPath,
      })
      expect(cmd).toContain('claude')
      expect(cmd).toContain('--session-id "abc-123"')
      expect(cmd).toContain(`--mcp-config ${JSON.stringify(cfgPath)}`)
      // Permissions stay interactive — the user is in the REPL pane and can
      // approve / deny tool calls (and see MCP auth prompts).
      expect(cmd.includes('--dangerously-skip-permissions')).toBe(false)
      // No `-p` (REPL mode — prompt arrives via stdin).
      expect(cmd.includes(' -p ')).toBe(false)
      // The MCP config file actually exists with the playwright server entry.
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
      expect(written.mcpServers.playwright.args).toContain('/tmp/out')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('claude REPL: omits --mcp-config when mcpOutputDir is missing', () => {
    const cmd = buildAgentSpawnCommand('claude', { sessionId: 'x' })
    expect(cmd.includes('--mcp-config')).toBe(false)
  })

  it('launches via the quoted absolute binaryPath when provided (restricted PATH)', () => {
    const claudeCmd = buildAgentSpawnCommand('claude', {
      binaryPath: '/Users/me/.local/bin/claude',
      sessionId: 'abc-123',
    })
    expect(claudeCmd.startsWith('"/Users/me/.local/bin/claude"')).toBe(true)
    expect(claudeCmd).toContain('--session-id "abc-123"')

    const codexResume = buildAgentSpawnCommand('codex', {
      binaryPath: '/opt/homebrew/bin/codex',
      resume: true,
      sessionId: 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f',
    })
    expect(codexResume.startsWith('"/opt/homebrew/bin/codex" resume "b2160db2-89b8-49ff-a2ba-c0c97a52d63f"')).toBe(true)
  })

  it('claude REPL: throws when mcpOutputDir is set but mcpConfigFile is not', () => {
    expect(() => buildAgentSpawnCommand('claude', { mcpOutputDir: '/tmp/out' }))
      .toThrow(/mcpConfigFile is required/)
  })

  it('claude REPL: omits --session-id when no UUID is supplied', () => {
    const cmd = buildAgentSpawnCommand('claude', {})
    expect(cmd.includes('--session-id')).toBe(false)
  })

  it('claude REPL: emits --resume <uuid> instead of --session-id when resume is true', () => {
    // On Restart Heal we want claude to continue the previous conversation
    // (full prior turns + tool results), not start a fresh session pinned to
    // the same uuid. `--resume` is the resumption flag; `--session-id` only
    // SETS the id for a new conversation.
    const cmd = buildAgentSpawnCommand('claude', {
      sessionId: 'abc-123',
      resume: true,
    })
    expect(cmd).toContain('--resume "abc-123"')
    expect(cmd.includes('--session-id')).toBe(false)
  })

  it('claude REPL: emits --session-id (not --resume) when resume is false', () => {
    const cmd = buildAgentSpawnCommand('claude', {
      sessionId: 'abc-123',
      resume: false,
    })
    expect(cmd).toContain('--session-id "abc-123"')
    expect(cmd.includes('--resume')).toBe(false)
  })

  it('claude REPL: omits both flags when resume is true but no sessionId is supplied', () => {
    // resume needs a target uuid to resume — without one there's nothing
    // to continue. Fall through to neither flag rather than emitting a
    // bare --resume (which would open claude's interactive picker).
    const cmd = buildAgentSpawnCommand('claude', { resume: true })
    expect(cmd.includes('--resume')).toBe(false)
    expect(cmd.includes('--session-id')).toBe(false)
  })

  it('codex REPL: fresh session uses no exec-only flags / --full-auto / --mcp-config / --session-id / --resume', () => {
    const cmd = buildAgentSpawnCommand('codex', {
      sessionId: 'ignored',
      resume: false,
      mcpOutputDir: '/tmp/out',
    })
    expect(cmd).toContain('codex')
    expect(cmd).not.toContain('--skip-git-repo-check')
    // --full-auto is gone for the same reason claude drops bypass-permissions:
    // the user is in the REPL and approves tool calls interactively.
    expect(cmd.includes('--full-auto')).toBe(false)
    expect(cmd.includes('--mcp-config')).toBe(false)
    expect(cmd.includes('--session-id')).toBe(false)
    // Codex resume is a subcommand, not a flag.
    expect(cmd.includes('--resume')).toBe(false)
    expect(cmd.includes('codex resume')).toBe(false)
  })

  it('codex REPL: resumes a prior session when resume + sessionId are supplied', () => {
    const cmd = buildAgentSpawnCommand('codex', {
      sessionId: 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f',
      resume: true,
      promptFile: '/tmp/run/heal-prompt.md',
    })
    expect(cmd).toBe('codex resume "b2160db2-89b8-49ff-a2ba-c0c97a52d63f" -- "@/tmp/run/heal-prompt.md"')
    expect(cmd.includes('--session-id')).toBe(false)
    expect(cmd.includes('--resume')).toBe(false)
  })

  it('claude / codex: appends `-- "@<promptFile>"` as a positional arg when promptFile is set', () => {
    // Cycle-1 prompt is delivered via claude's `@<path>` syntax instead of
    // stdin paste — sidesteps the REPL's input editor (which doesn't
    // reliably submit multi-line content) and produces clean output.
    const claudeCmd = buildAgentSpawnCommand('claude', { promptFile: '/tmp/run/heal-prompt.md' })
    expect(claudeCmd).toContain('-- "@/tmp/run/heal-prompt.md"')
    expect(claudeCmd.endsWith('-- "@/tmp/run/heal-prompt.md"')).toBe(true)

    const codexCmd = buildAgentSpawnCommand('codex', { promptFile: '/tmp/run/heal-prompt.md' })
    expect(codexCmd).toContain('-- "@/tmp/run/heal-prompt.md"')
    expect(codexCmd.endsWith('-- "@/tmp/run/heal-prompt.md"')).toBe(true)
  })

  it('uses `--` so --mcp-config does not slurp the positional @<promptFile>', () => {
    // Regression: `--mcp-config <configs...>` is variadic. Without a `--`
    // separator before the positional, claude treats `"@<promptFile>"` as
    // another config file path — opens it, fails JSON parse, exits with
    // `Invalid MCP configuration: MCP config file not found: <cwd>/@<path>`.
    // The POSIX `--` end-of-options marker terminates flag parsing.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-prompt-')))
    try {
      const cfgPath = path.join(tmp, 'mcp-config.json')
      const cmd = buildAgentSpawnCommand('claude', {
        sessionId: 'abc-123',
        mcpOutputDir: '/tmp/out',
        mcpConfigFile: cfgPath,
        promptFile: '/tmp/run/heal-prompt.md',
      })
      // The `--` must appear AFTER --mcp-config and BEFORE the @-prefixed
      // positional. Anything else means the variadic collector wins.
      const mcpIdx = cmd.indexOf('--mcp-config')
      const sepIdx = cmd.indexOf(' -- ')
      const promptIdx = cmd.indexOf('"@/tmp/run/heal-prompt.md"')
      expect(mcpIdx).toBeGreaterThan(0)
      expect(sepIdx).toBeGreaterThan(mcpIdx)
      expect(promptIdx).toBeGreaterThan(sepIdx)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('omits the `@<promptFile>` arg when promptFile is not set', () => {
    const cmd = buildAgentSpawnCommand('claude', { sessionId: 'x' })
    expect(cmd.includes('@')).toBe(false)
    // No `--` separator either when there's no positional to protect.
    expect(cmd.includes(' -- ')).toBe(false)
  })

  it('splices --model <id> when HEAL_MODELS has a pinned model for the agent (line 301 true branch)', () => {
    // Temporarily pin a model so the modelFlag branch is exercised.
    const prev = HEAL_MODELS.claude
    try {
      HEAL_MODELS.claude = 'claude-haiku-4-5'
      const cmd = buildAgentSpawnCommand('claude', { sessionId: 'x' })
      expect(cmd).toContain('--model "claude-haiku-4-5"')
    } finally {
      HEAL_MODELS.claude = prev
    }
  })
})

describe('readPriorSessionId', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-prior-sid-')))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns null when the file does not exist', () => {
    expect(readPriorSessionId(path.join(tmp, 'nope.txt'))).toBeNull()
  })

  it('returns the trimmed UUID for a well-formed file', () => {
    const file = path.join(tmp, 'sid.txt')
    fs.writeFileSync(file, '  b2160db2-89b8-49ff-a2ba-c0c97a52d63f\n')
    expect(readPriorSessionId(file)).toBe('b2160db2-89b8-49ff-a2ba-c0c97a52d63f')
  })

  it('accepts uppercase UUIDs (claude renders them this way in the UI)', () => {
    const file = path.join(tmp, 'sid.txt')
    fs.writeFileSync(file, 'B2160DB2-89B8-49FF-A2BA-C0C97A52D63F')
    expect(readPriorSessionId(file)).toBe('B2160DB2-89B8-49FF-A2BA-C0C97A52D63F')
  })

  it('returns null for an empty file', () => {
    const file = path.join(tmp, 'sid.txt')
    fs.writeFileSync(file, '')
    expect(readPriorSessionId(file)).toBeNull()
  })

  it('returns null for garbage that is not a UUID', () => {
    const file = path.join(tmp, 'sid.txt')
    fs.writeFileSync(file, 'not-a-uuid')
    expect(readPriorSessionId(file)).toBeNull()
  })

  it('returns null when the file contains extra trailing content after a UUID', () => {
    // A file with a UUID followed by anything else (multi-line, extra
    // tokens) is treated as corrupt — better to start a fresh session
    // than feed claude a malformed --resume target.
    const file = path.join(tmp, 'sid.txt')
    fs.writeFileSync(file, 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f extra')
    expect(readPriorSessionId(file)).toBeNull()
  })

  it('validates a raw persisted session id value without reading a file', () => {
    expect(readPriorSessionIdFromValue(' b2160db2-89b8-49ff-a2ba-c0c97a52d63f\n'))
      .toBe('b2160db2-89b8-49ff-a2ba-c0c97a52d63f')
    expect(readPriorSessionIdFromValue('not-a-uuid')).toBeNull()
  })
})

// Deps that find nothing — `which` misses and no candidate path is executable.
const NONE: AgentResolveDeps = {
  which: () => null,
  isExecutable: () => false,
  homedir: () => '/no/such/home',
  env: {},
}
// Deps where only the named agent resolves via `which`.
const onPath = (present: HealAgent): AgentResolveDeps => ({
  which: (agent) => (agent === present ? `/usr/local/bin/${agent}` : null),
  isExecutable: () => false,
  homedir: () => '/no/such/home',
  env: {},
})

describe('resolveAgentBinary', () => {
  it('returns the `which` path when the agent is on PATH', () => {
    expect(resolveAgentBinary('claude', onPath('claude'))).toBe('/usr/local/bin/claude')
  })

  it('falls back to a well-known location when not on PATH (restricted PATH)', () => {
    const localBin = '/home/me/.local/bin/claude'
    const found = resolveAgentBinary('claude', {
      which: () => null,
      isExecutable: (p) => p === localBin,
      homedir: () => '/home/me',
      env: {},
    })
    expect(found).toBe(localBin)
  })

  it('honors an explicit CANARY_LAB_CLAUDE_BIN override', () => {
    const found = resolveAgentBinary('claude', {
      which: () => '/usr/local/bin/claude',
      isExecutable: (p) => p === '/opt/custom/claude',
      homedir: () => '/home/me',
      env: { CANARY_LAB_CLAUDE_BIN: '/opt/custom/claude' },
    })
    expect(found).toBe('/opt/custom/claude')
  })

  it('returns null when nothing resolves', () => {
    expect(resolveAgentBinary('codex', NONE)).toBeNull()
  })

  // Exercise the PRODUCTION default seams (real `which` / fs.accessSync) by
  // leaving them un-injected. These run on unix CI where `which`, `/bin/sh`
  // are present.
  describe('default seams (real which / fs probe)', () => {
    it('defaultWhich resolves a real binary on PATH', () => {
      // `sh` is on PATH on any unix; leave `which` un-injected so defaultWhich
      // shells out to the real `which`.
      const found = resolveAgentBinary('sh' as unknown as HealAgent, {
        env: {},
        homedir: () => '/no/such/home',
        isExecutable: () => false,
      })
      expect(found).toMatch(/sh$/)
    })

    it('defaultWhich returns null (catch arm) for a binary that is not on PATH', () => {
      const found = resolveAgentBinary('canary-lab-no-such-binary-zzz' as unknown as HealAgent, {
        env: {},
        homedir: () => '/no/such/home',
        isExecutable: () => false,
      })
      expect(found).toBeNull()
    })

    it('defaultIsExecutable returns true for a real executable (env override path)', () => {
      const found = resolveAgentBinary('claude', {
        which: () => null,
        homedir: () => '/no/such/home',
        env: { CANARY_LAB_CLAUDE_BIN: '/bin/sh' },
      })
      expect(found).toBe('/bin/sh')
    })

    it('falls back to process.env / os.homedir when neither is injected', () => {
      // No `env` and no `homedir` deps → the `?? process.env` and
      // `: os.homedir()` defaults are taken. which/isExecutable stubbed so the
      // resolution is deterministic (and never finds anything).
      const found = resolveAgentBinary('claude', { which: () => null, isExecutable: () => false })
      expect(found).toBeNull()
    })

    it('defaultIsExecutable returns false (catch arm) for a missing path', () => {
      const found = resolveAgentBinary('claude', {
        which: () => null,
        homedir: () => '/no/such/home',
        env: { CANARY_LAB_CLAUDE_BIN: '/no/such/path/claude' },
      })
      expect(found).toBeNull()
    })
  })
})

describe('isAgentCliAvailable', () => {
  it('returns true when the agent resolves', () => {
    expect(isAgentCliAvailable('claude', onPath('claude'))).toBe(true)
  })

  it('returns false when the agent resolves nowhere', () => {
    expect(isAgentCliAvailable('codex', NONE)).toBe(false)
  })
})

describe('pickAvailableHealAgent', () => {
  it('returns null when env override names a missing CLI', () => {
    expect(pickAvailableHealAgent('claude', NONE)).toBe(null)
  })

  it('returns the override agent when its CLI resolves', () => {
    expect(pickAvailableHealAgent('codex', onPath('codex'))).toBe('codex')
  })

  it('returns null when override is unrelated to claude/codex (typo guard)', () => {
    const which = vi.fn(() => null)
    // Unrecognised non-empty override returns null without probing.
    expect(pickAvailableHealAgent('clauude', { which })).toBe(null)
    expect(which).not.toHaveBeenCalled()
  })

  it('auto-detects claude first when no override is set', () => {
    expect(pickAvailableHealAgent('', onPath('claude'))).toBe('claude')
  })

  it('falls back to codex when claude is absent but codex is present', () => {
    expect(pickAvailableHealAgent('', onPath('codex'))).toBe('codex')
  })

  it('returns null when neither claude nor codex resolves', () => {
    expect(pickAvailableHealAgent('', NONE)).toBe(null)
  })
})

describe('buildHealPromptMap', () => {
  let tmp: string
  let runDir: string
  let projectRoot: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-map-')))
    runDir = path.join(tmp, 'run')
    projectRoot = path.join(tmp, 'project')
    fs.mkdirSync(runDir, { recursive: true })
    fs.mkdirSync(projectRoot, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('maps available service-mode resources and omits unavailable placeholders', () => {
    const featureDir = path.join(projectRoot, 'features', 'checkout')
    writeRunManifest(runDir, {
      featureDir,
      repoPaths: ['/repo/app'],
    })
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'heal-index.md'), '# Heal Index\n')
    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), '{}\n')
    fs.writeFileSync(path.join(runDir, 'diagnosis-journal.md'), '# Journal\n')
    fs.mkdirSync(path.join(runDir, 'failed', 'checkout-fails'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'failed', 'checkout-fails', 'api.log'), 'slice')
    fs.mkdirSync(path.join(runDir, 'failed', 'checkout-fails', 'trace-extract'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'failed', 'checkout-fails', 'trace-extract', 'failure-summary.md'), 'trace')
    fs.mkdirSync(path.join(runDir, 'failed', 'checkout-fails', 'playwright-mcp'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'failed', 'checkout-fails', 'playwright-mcp', 'snapshot.png'), 'png')
    fs.writeFileSync(path.join(runDir, 'svc-api.log'), 'full log')
    const wikiPath = path.join(tmp, 'wiki')
    fs.mkdirSync(wikiPath, { recursive: true })

    const healPrompt = buildHealPromptMap({
      projectRoot,
      runDir,
      personalWikiPath: wikiPath,
    })

    expect(healPrompt).toMatchObject({
      source: 'canary-lab/heal-agent-map',
      mode: 'service',
      runDir,
      runDirRel: '../run',
      startHere: [
        {
          id: 'heal-index',
          field: 'healIndexMarkdown',
          path: path.join(runDir, 'heal-index.md'),
        },
      ],
      boundaries: {
        fixTarget: expect.stringContaining('Fix service/app code, not tests.'),
        signalPolicy: {
          serviceOrRuntimeChange: 'restart',
          testOrConfigOnlyChange: 'rerun',
          mechanism: 'call signal_run; do not write signal files directly',
        },
      },
    })
    expect(healPrompt.resources.map((entry) => entry.id)).toEqual([
      'failed-slices',
      'trace-extract',
      'playwright-mcp',
      'full-service-log',
      'journal',
      'feature-docs',
      'personal-wiki',
    ])
    expect(JSON.stringify(healPrompt)).not.toContain('{{')
    expect(JSON.stringify(healPrompt)).not.toContain('null')
  })

  it('falls back to summary and test-mode boundaries when heal-index is unavailable', () => {
    writeRunManifest(runDir, { repoPaths: [] })
    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), '{}\n')
    fs.mkdirSync(path.join(runDir, 'failed', 'checkout-fails', 'playwright-mcp'), { recursive: true })
    fs.writeFileSync(path.join(runDir, 'failed', 'checkout-fails', 'playwright-mcp', '_attribution.json'), '[]')

    const healPrompt = buildHealPromptMap({ projectRoot, runDir })

    expect(healPrompt.mode).toBe('test')
    expect(healPrompt.startHere).toEqual([
      {
        id: 'summary',
        field: 'summary',
        path: path.join(runDir, 'e2e-summary.json'),
        purpose: 'Raw Playwright summary. Use when heal-index.md is missing or incomplete.',
      },
    ])
    expect(healPrompt.resources).toEqual([])
    expect(healPrompt.boundaries.fixTarget).toContain('This feature has no editable service repos')
    expect(healPrompt.boundaries.fixTarget).toContain('Read the failing test spec and its helpers')
  })
})

describe('buildOrchestratorHealPrompt', () => {
  let tmp: string
  let runDir: string
  let projectRoot: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-')))
    runDir = path.join(tmp, 'run')
    projectRoot = path.join(tmp, 'project')
    fs.mkdirSync(runDir, { recursive: true })
    fs.mkdirSync(projectRoot, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('throws synchronously when the packaged prompt template is missing', () => {
    expect(() => buildOrchestratorHealPrompt({
      agent: 'claude',
      projectRoot,
      runDir,
      promptPath: path.join(tmp, 'missing.md'),
    })).toThrow(/Heal prompt template not found/)
  })

  it('returns a buildCyclePrompt that writes the rendered run-scoped prompt', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    // Prompt file was written under runDir.
    const promptPath = path.join(runDir, 'heal-prompt.md')
    expect(fs.existsSync(promptPath)).toBe(true)
    const promptBody = fs.readFileSync(promptPath, 'utf-8')
    expect(promptBody).toContain(`Run directory:\n- \`${runDir}\` (\`../run\` from the project root)`)
    expect(promptBody).toContain(path.join(runDir, 'heal-index.md'))
    expect(promptBody).toContain(path.join(runDir, 'e2e-summary.json'))
    expect(promptBody).toContain(path.join(runDir, 'failed'))
    expect(promptBody).toContain(path.join(runDir, 'diagnosis-journal.md'))
    expect(promptBody).toContain(path.join(runDir, 'signals', '.restart'))
    expect(promptBody).toContain(path.join(runDir, 'signals', '.rerun'))
    expect(promptBody).not.toContain('{{')
    // Returned prompt is the same content the orchestrator pty.write()s.
    expect(prompt).toBe(promptBody)
  })

  it('renders service-mode copy when manifest.repoPaths is non-empty', () => {
    writeRunManifest(runDir, { repoPaths: ['/some/repo'] })
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('Fix service/app code, not tests.')
    expect(prompt).toContain('Do not read the test spec unless')
    expect(prompt).toContain('Do NOT Read the test spec file')
    expect(prompt).not.toContain('no editable service repos')
  })

  it('surfaces feature docs when the accepted feature has preserved context', () => {
    const featureDir = path.join(projectRoot, 'features', 'context_docs')
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    writeRunManifest(runDir, {
      feature: 'context_docs',
      featureDir,
      repoPaths: ['/some/repo'],
    })
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('Feature context docs:')
    expect(prompt).toContain(path.join(featureDir, 'docs'))
    expect(prompt).toContain('uploaded Add Test documents and additional notes')
  })

  it('renders test-mode copy when manifest.repoPaths is empty', () => {
    writeRunManifest(runDir, { repoPaths: [] })
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('This feature has no editable service repos')
    expect(prompt).toContain('Read the failing test spec and its helpers')
    // The service-mode prohibition must be absent in test mode (both the
    // static rule and the per-cycle addendum reinforcement).
    expect(prompt).not.toContain('Fix service/app code, not tests.')
    expect(prompt).not.toContain('Do not read the test spec unless')
    expect(prompt).not.toContain('Do NOT Read the test spec file')
  })

  it('defaults to service-mode copy when manifest.json is missing', () => {
    // A transient I/O glitch or a test fixture without a manifest must not
    // silently flip to test-mode for a feature that does have editable repos.
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('Fix service/app code, not tests.')
    expect(prompt).not.toContain('no editable service repos')
  })

  it('auto-heal does not depend on project CLAUDE.md / AGENTS.md', () => {
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), 'custom user notes without markers')
    fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'custom codex notes without markers')

    expect(() => buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })).not.toThrow()
    expect(() => buildOrchestratorHealPrompt({ agent: 'codex', projectRoot, runDir })).not.toThrow()
  })

  it('appends restart user guidance to the rendered heal prompt', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'codex', projectRoot, runDir })
    build({ cycle: 0, outputDir: path.join(runDir, 'out'), userGuidance: 'focus on the webhook fallback' })
    const promptBody = fs.readFileSync(path.join(runDir, 'heal-prompt.md'), 'utf-8')
    expect(promptBody).toContain('User guidance for this restarted heal cycle')
    expect(promptBody).toContain('focus on the webhook fallback')
  })

  it('appends prior cross-agent session context to the rendered heal prompt', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'codex', projectRoot, runDir })
    build({
      cycle: 0,
      outputDir: path.join(runDir, 'out'),
      priorAgentSessionContext: 'Previous claude session sid:\nASSISTANT: check CNS_V1_BASE_URL',
    })
    const promptBody = fs.readFileSync(path.join(runDir, 'heal-prompt.md'), 'utf-8')
    expect(promptBody).toContain('Previous agent session context from another agent')
    expect(promptBody).toContain('Previous claude session sid:')
    expect(promptBody).toContain('check CNS_V1_BASE_URL')
  })

  it('includes configured personal wiki context in the rendered heal prompt', () => {
    const wiki = path.join(tmp, 'wiki')
    const build = buildOrchestratorHealPrompt({
      agent: 'codex',
      projectRoot,
      runDir,
      personalWikiPath: wiki,
    })
    build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    const promptBody = fs.readFileSync(path.join(runDir, 'heal-prompt.md'), 'utf-8')
    expect(promptBody).toContain(`- \`${wiki}\``)
    expect(promptBody).toContain('cross-linked markdown')
    expect(promptBody).toContain('follow links rather than re-grepping')
    expect(promptBody).toContain('Consult when the current failure seems related to prior work.')
  })

  it('omits personal wiki context when no wiki path is configured', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'codex', projectRoot, runDir })
    build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    const promptBody = fs.readFileSync(path.join(runDir, 'heal-prompt.md'), 'utf-8')
    expect(promptBody).not.toContain('cross-linked markdown')
    expect(promptBody).not.toContain('{{personalWikiMap}}')
  })

  it('omits the playwright-mcp bullet when no failure dir has MCP artifacts', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(prompt).not.toContain('playwright-mcp/')
    expect(prompt).not.toContain('console logs / DOM snapshots / network captures the Playwright MCP server')
  })

  it('emits the playwright-mcp bullet when at least one failure dir has MCP artifacts', () => {
    const mcpDir = path.join(runDir, 'failed', 'test-case-broken', 'playwright-mcp')
    fs.mkdirSync(mcpDir, { recursive: true })
    fs.writeFileSync(path.join(mcpDir, 'snapshot.png'), 'fake')
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('playwright-mcp/')
    expect(prompt).toContain('console logs / DOM snapshots / network captures the Playwright MCP server')
  })

  it('treats playwright-mcp dirs containing only `_attribution.json` as empty', () => {
    const mcpDir = path.join(runDir, 'failed', 'test-case-x', 'playwright-mcp')
    fs.mkdirSync(mcpDir, { recursive: true })
    fs.writeFileSync(path.join(mcpDir, '_attribution.json'), '[]')
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(prompt).not.toContain('playwright-mcp/')
  })

  it('omits the trace-extract bullet when no failure dir has a failure-summary.md', () => {
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(prompt).not.toContain('trace-extract/failure-summary.md')
  })

  it('emits the trace-extract bullet when at least one failure has a failure-summary.md', () => {
    const traceDir = path.join(runDir, 'failed', 'test-case-broken', 'trace-extract')
    fs.mkdirSync(traceDir, { recursive: true })
    fs.writeFileSync(path.join(traceDir, 'failure-summary.md'), '# Failure summary')
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('trace-extract/failure-summary.md')
    expect(prompt).toContain('curated extract of the failing Playwright run')
  })

  it('agent-agnostic: rendered prompt body is the same for claude and codex', () => {
    // The prompt is the conversation content; the agent flag only controls
    // the spawn command. Renderers must not branch on agent.
    const buildC = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const promptC = buildC({ cycle: 0, outputDir: path.join(runDir, 'out') })
    const buildX = buildOrchestratorHealPrompt({ agent: 'codex', projectRoot, runDir })
    const promptX = buildX({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(promptC).toBe(promptX)
  })

  it('omits the stuck-cycle escalation when consecutiveSameFailures is not supplied', () => {
    // Default path: prior cycles, but no streak threading. Escalation stays
    // hidden so we don't surface it spuriously to legacy callers.
    fs.writeFileSync(
      path.join(runDir, 'e2e-summary.json'),
      JSON.stringify({ failed: [{ name: 'test-a' }] }),
    )
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({ cycle: 5, outputDir: path.join(runDir, 'out') })
    expect(prompt).not.toContain('Escalation:')
  })

  it('emits the stuck-cycle escalation when consecutiveSameFailures crosses the threshold', () => {
    // End-to-end: the orchestrator's streak value flows through the cycle
    // prompt builder into the addendum block. Concrete failedDir path is
    // present in the escalation bullet so the agent can Read directly.
    fs.writeFileSync(
      path.join(runDir, 'e2e-summary.json'),
      JSON.stringify({ failed: [{ name: 'test-a' }, { name: 'test-b' }] }),
    )
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot, runDir })
    const prompt = build({
      cycle: 2, // becomes cycle 3 in the addendum after the +1 mapping
      outputDir: path.join(runDir, 'out'),
      consecutiveSameFailures: 3,
    })
    expect(prompt).toContain('Escalation: this is cycle 3 with the same failing set (test-a, test-b).')
    // The failedDir path the addendum embeds is the same one the static
    // template uses — confirms threading through buildHealAddendum.
    expect(prompt).toContain(`${path.join(runDir, 'failed')}/<slug>/trace-extract/snapshot-at-failure.txt`)
  })
})

describe('renderPlaywrightMcpHint', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-'))) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('returns empty string when failed dir does not exist', () => {
    expect(renderPlaywrightMcpHint(path.join(tmp, 'nonexistent'))).toBe('')
  })

  it('returns empty string when no failure dir has a non-empty playwright-mcp/', () => {
    fs.mkdirSync(path.join(tmp, 'a'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'b', 'playwright-mcp'), { recursive: true })
    expect(renderPlaywrightMcpHint(tmp)).toBe('')
  })

  it('returns a bullet when any failure dir has files in playwright-mcp/', () => {
    fs.mkdirSync(path.join(tmp, 'a', 'playwright-mcp'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'a', 'playwright-mcp', 'snap.png'), 'fake')
    expect(renderPlaywrightMcpHint(tmp)).toContain('playwright-mcp/')
  })
})

describe('renderTraceExtractHint', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-trace-'))) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('returns empty string when no failure dir has trace-extract/failure-summary.md', () => {
    fs.mkdirSync(path.join(tmp, 'a'), { recursive: true })
    expect(renderTraceExtractHint(tmp)).toBe('')
  })

  it('returns a bullet when at least one failure has a failure-summary.md', () => {
    fs.mkdirSync(path.join(tmp, 'a', 'trace-extract'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'a', 'trace-extract', 'failure-summary.md'), 'x')
    expect(renderTraceExtractHint(tmp)).toContain('failure-summary.md')
  })
})

describe('buildPersonalWikiMap', () => {
  it('returns an empty section for unset paths', () => {
    expect(renderPersonalWikiMap(null)).toBe('')
    expect(renderPersonalWikiMap('')).toBe('')
  })
})

describe('auto-heal branch edge cases', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-edge-')))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('buildHealPromptMap: runDirRel falls back to runDir when projectRoot === runDir', () => {
    // path.relative(x, x) === '' so the `|| opts.runDir` branch is taken.
    const runDir = tmp
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })
    const map = buildHealPromptMap({ projectRoot: runDir, runDir })
    expect(map.runDirRel).toBe(runDir)
  })

  it('buildOrchestratorHealPrompt: runDirRel falls back to runDir when projectRoot === runDir', () => {
    const runDir = tmp
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot: runDir, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    // Renders `<runDir> (`<runDir>` from the project root)` — RHS of the `||`.
    expect(prompt).toContain(`Run directory:\n- \`${runDir}\` (\`${runDir}\` from the project root)`)
  })

  it('skips a stray non-directory entry alongside failure dirs (failure-log / trace / mcp scans)', () => {
    const runDir = path.join(tmp, 'run')
    const failedDir = path.join(runDir, 'failed')
    fs.mkdirSync(failedDir, { recursive: true })
    // Stray file directly under failedDir — must be skipped by `!isDirectory()`.
    // Named so it sorts BEFORE the real failure dir; readdirSync yields it
    // first, so the `!isDirectory() continue` runs before the dir match returns.
    fs.writeFileSync(path.join(failedDir, '0-stray.txt'), 'not a dir')
    // A real failure dir with all three artifact kinds so the scans iterate
    // past the stray file and still find the directory entry.
    const slug = path.join(failedDir, 'case-1')
    fs.mkdirSync(path.join(slug, 'trace-extract'), { recursive: true })
    fs.writeFileSync(path.join(slug, 'api.log'), 'slice')
    fs.writeFileSync(path.join(slug, 'trace-extract', 'failure-summary.md'), 'trace')
    fs.mkdirSync(path.join(slug, 'playwright-mcp'), { recursive: true })
    fs.writeFileSync(path.join(slug, 'playwright-mcp', 'snap.png'), 'png')
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })

    const map = buildHealPromptMap({ projectRoot: tmp, runDir })
    const ids = map.resources.map((r) => r.id)
    // failed-slices (hasAnyFailureLog), trace-extract (hasAnyFailureWith),
    // playwright-mcp (hasAnyFailureWithNonEmptyDir) all reached past the stray.
    expect(ids).toContain('failed-slices')
    expect(ids).toContain('trace-extract')
    expect(ids).toContain('playwright-mcp')
  })

  it('featureDocsDir returns null when the docs dir is missing (directoryExists catch)', () => {
    // featureDir set but no `docs` subdir → statSync throws → directoryExists
    // returns false via its catch → no feature-docs resource.
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    const featureDir = path.join(tmp, 'features', 'no_docs')
    fs.mkdirSync(featureDir, { recursive: true })
    writeRunManifest(runDir, { featureDir, repoPaths: ['/repo/app'] })

    const map = buildHealPromptMap({ projectRoot: tmp, runDir })
    expect(map.resources.map((r) => r.id)).not.toContain('feature-docs')
  })

  it('renderPromptTemplate drops a placeholder-only line whose key is absent from values', () => {
    // Custom template with a placeholder-only line referencing a key that is
    // NOT in the values map buildOrchestratorHealPrompt passes. The
    // `values[m[1]] ?? ''` nullish fallback makes its length 0, so the line
    // is dropped (covers the `?? ''` RHS branch).
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    const templatePath = path.join(tmp, 'tmpl.md')
    fs.writeFileSync(
      templatePath,
      [
        'Run dir: {{runDir}}',
        '{{notAKnownKey}}',
        // Mixed line (not placeholder-only) referencing an unknown key — kept,
        // and the replace callback returns `match` for the missing key (the
        // `?? match` RHS branch).
        'mixed prefix {{alsoUnknown}} suffix',
        'tail line',
      ].join('\n'),
    )
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })
    const build = buildOrchestratorHealPrompt({
      agent: 'claude',
      projectRoot: tmp,
      runDir,
      promptPath: templatePath,
    })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain(`Run dir: ${runDir}`)
    expect(prompt).toContain('tail line')
    // The unknown-key placeholder line was dropped entirely.
    expect(prompt).not.toContain('{{notAKnownKey}}')
    // The mixed line is kept; the unknown placeholder is left verbatim.
    expect(prompt).toContain('mixed prefix {{alsoUnknown}} suffix')
  })

  it('failure-artifact scans return false when failedDir exists but is not a directory', () => {
    // failedDir exists (existsSync true) but readdirSync throws ENOTDIR — the
    // `catch { return false }` arms in hasAnyFailureWith /
    // hasAnyFailureWithNonEmptyDir / hasAnyFailureLog are exercised.
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    // buildRunPaths derives failedDir = <runDir>/failed; make it a FILE.
    fs.writeFileSync(path.join(runDir, 'failed'), 'i am a file, not a dir')
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })

    const map = buildHealPromptMap({ projectRoot: tmp, runDir })
    const ids = map.resources.map((r) => r.id)
    expect(ids).not.toContain('failed-slices')
    expect(ids).not.toContain('trace-extract')
    expect(ids).not.toContain('playwright-mcp')
  })

  it('hasAnyFailureLog skips a failure dir whose contents cannot be read (inner catch)', () => {
    // A failure dir entry that is itself unreadable (chmod 000) makes the
    // inner readdirSync throw EACCES — the `catch { continue }` arm runs and
    // the scan moves on, finding the readable sibling's .log.
    const runDir = path.join(tmp, 'run')
    const failedDir = path.join(runDir, 'failed')
    fs.mkdirSync(failedDir, { recursive: true })
    const blocked = path.join(failedDir, '0-blocked')
    fs.mkdirSync(blocked, { recursive: true })
    fs.writeFileSync(path.join(blocked, 'x.log'), 'log')
    const readable = path.join(failedDir, 'z-readable')
    fs.mkdirSync(readable, { recursive: true })
    fs.writeFileSync(path.join(readable, 'y.log'), 'log')
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })
    fs.chmodSync(blocked, 0o000)
    try {
      const map = buildHealPromptMap({ projectRoot: tmp, runDir })
      expect(map.resources.map((r) => r.id)).toContain('failed-slices')
    } finally {
      fs.chmodSync(blocked, 0o755)
    }
  })

  it('hasAnyServiceLog returns false when the run dir cannot be read', () => {
    // runDir exists but is unreadable — readdirSync throws and the
    // `catch { return false }` in hasAnyServiceLog is exercised.
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    writeRunManifest(runDir, { repoPaths: ['/repo/app'] })
    fs.chmodSync(runDir, 0o000)
    try {
      const map = buildHealPromptMap({ projectRoot: tmp, runDir })
      expect(map.resources.map((r) => r.id)).not.toContain('full-service-log')
    } finally {
      fs.chmodSync(runDir, 0o755)
    }
  })

  it('detectHealMode (via prompt) treats a manifest without repoPaths as test mode', () => {
    // manifest present but repoPaths absent → Array.isArray(undefined) is
    // false → `: []` branch → length 0 → test mode.
    const runDir = path.join(tmp, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    writeRunManifest(runDir, {})
    const build = buildOrchestratorHealPrompt({ agent: 'claude', projectRoot: tmp, runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'out') })
    expect(prompt).toContain('This feature has no editable service repos')
  })
})
