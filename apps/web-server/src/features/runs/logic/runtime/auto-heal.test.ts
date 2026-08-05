import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildAgentSpawnCommand, buildClaudeMcpConfigArg, isAgentCliAvailable, makeAgentSpawnCommandBuilder, pickAvailableHealAgent, readPriorSessionId, readPriorSessionIdFromValue, resolveAgentBinary, type AgentResolveDeps, type HealAgent } from './auto-heal'
import { HEAL_MODELS } from '../../../agent-sessions/logic/agent-models'

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

  it('claude REPL: grants edits AND bash up front, because both strand a repair', () => {
    // `acceptEdits` covered edits only. Bash went to the command-safety
    // classifier, and a glob or `$var` expansion defeats it ("Contains
    // simple_expansion") — observed live 2026-08-04, where a finished, correct
    // repair was reported as FAILED because the agent froze reading its own
    // evidence. `auto` covers both and keeps the safety classifier that
    // --dangerously-skip-permissions discards.
    const cmd = buildAgentSpawnCommand('claude', { sessionId: 'x' })
    expect(cmd).toContain('--permission-mode auto')
    expect(cmd.includes('acceptEdits')).toBe(false)
    // Still not the blanket bypass.
    expect(cmd.includes('--dangerously-skip-permissions')).toBe(false)
  })

  it('grants each writable dir on both arms — cwd is the run dir, so repos are out of scope', () => {
    // The third gate, which no permission mode covers: the agent's cwd is the
    // run directory, so its first touch of a repo asks "allow reading from …?"
    // and nothing answers. Deduped, because two services can share one repo.
    for (const agent of ['claude', 'codex'] as const) {
      const cmd = buildAgentSpawnCommand(agent, {
        sessionId: 'x',
        writableDirs: ['/repos/api', '/repos/api', '/ws/features/demo'],
      })
      expect(cmd).toContain('--add-dir "/repos/api"')
      expect(cmd).toContain('--add-dir "/ws/features/demo"')
      expect(cmd.match(/--add-dir/g)).toHaveLength(2)
    }
  })

  it('codex REPL: never asks for approval, on a fresh spawn and on resume', () => {
    // A sandbox refusal returns to the model as an execution failure it can
    // report; an approval prompt is one it waits on until the watchdog fires.
    const fresh = buildAgentSpawnCommand('codex', {})
    expect(fresh).toContain('-a never')
    expect(fresh).toContain('--sandbox workspace-write')
    expect(fresh).not.toContain('--disable hooks')
    const resumed = buildAgentSpawnCommand('codex', { sessionId: 'sid', resume: true })
    expect(resumed).toContain('-a never')
    expect(resumed).toContain('--sandbox workspace-write')
    expect(resumed).toContain('resume "sid"')
    // Approvals off, but the sandbox stays on.
    expect(resumed.includes('--dangerously-bypass-approvals-and-sandbox')).toBe(false)
  })

  it('codex REPL: trusts only this workspace for the invocation without bypassing the sandbox', () => {
    const workspace = path.join(os.tmpdir(), "canary $(touch nope) 'demo'", 'repo')
    const cmd = buildAgentSpawnCommand('codex', { workspaceRoot: workspace })
    const canonical = path.resolve(workspace)
    const override = `projects={${JSON.stringify(canonical)}={trust_level="trusted"}}`
    const shellArg = `'${override.replace(/'/g, `'"'"'`)}'`

    expect(cmd).toContain(`--disable hooks -c ${shellArg}`)
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('claude REPL: ignores the Codex-only invocation trust override', () => {
    const cmd = buildAgentSpawnCommand('claude', { workspaceRoot: '/workspace/demo' })
    expect(cmd).not.toContain('trust_level')
    expect(cmd).not.toContain('projects.')
    expect(cmd).not.toContain('--disable hooks')
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
    expect(codexResume.startsWith('"/opt/homebrew/bin/codex" -a never --sandbox workspace-write resume "b2160db2-89b8-49ff-a2ba-c0c97a52d63f"')).toBe(true)
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
    // `-a never` sits before the subcommand, same as `--model` — clap reads it
    // as a global flag there. Verified against the codex CLI's own parser.
    expect(cmd).toBe('codex -a never --sandbox workspace-write resume "b2160db2-89b8-49ff-a2ba-c0c97a52d63f" -- "@/tmp/run/heal-prompt.md"')
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

describe('makeAgentSpawnCommandBuilder', () => {
  it('forwards orchestrator arguments while binding run-specific defaults', () => {
    const build = makeAgentSpawnCommandBuilder('codex', {
      binaryPath: '/opt/bin/codex',
      mcpConfigFile: '/runs/demo/mcp-config.json',
    })

    const cmd = build({
      resume: true,
      sessionId: 'session-1',
      promptFile: '/runs/demo/heal-prompt.md',
      writableDirs: ['/runs/demo/worktrees/api', '/workspace/features/demo'],
    })

    expect(cmd).toContain('"/opt/bin/codex"')
    expect(cmd).toContain('--add-dir "/runs/demo/worktrees/api"')
    expect(cmd).toContain('--add-dir "/workspace/features/demo"')
    expect(cmd).toContain('resume "session-1"')
    expect(cmd).toContain('-- "@/runs/demo/heal-prompt.md"')
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
