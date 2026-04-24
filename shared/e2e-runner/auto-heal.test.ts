import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { StartTab } from '../launcher/startup'

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

// Shared mutable tmp-scoped "paths" that auto-heal.ts imports at module init.
const pathStubRoot = mkTmp()
const LOGS_DIR = path.join(pathStubRoot, 'logs')
const RERUN_SIGNAL = path.join(LOGS_DIR, '.rerun')
const RESTART_SIGNAL = path.join(LOGS_DIR, '.restart')
fs.mkdirSync(LOGS_DIR, { recursive: true })

const ITERM_HEAL_SESSION_IDS_PATH = path.join(LOGS_DIR, 'iterm-heal-session-ids.json')

vi.mock('./paths', () => ({
  ROOT: pathStubRoot,
  LOGS_DIR,
  RERUN_SIGNAL,
  RESTART_SIGNAL,
  ITERM_HEAL_SESSION_IDS_PATH,
}))

const openItermTabs = vi.fn((_tabs: StartTab[], _label: string) => ['SID-1'])
const reuseItermTabs = vi.fn(
  (_ids: string[], _tabs: StartTab[], _label: string) => false,
)
const closeItermSessionsByPrefix = vi.fn((_prefixes: string[]) => {})
const closeItermSessionsByIds = vi.fn((_ids: string[]) => {})
vi.mock('../launcher/iterm', () => ({
  openItermTabs,
  reuseItermTabs,
  closeItermSessionsByPrefix,
  closeItermSessionsByIds,
}))

const openTerminalTabs = vi.fn()
const closeTerminalTabsByPrefix = vi.fn()
vi.mock('../launcher/terminal', () => ({
  openTerminalTabs,
  closeTerminalTabsByPrefix,
}))

const execFileSync = vi.fn()
vi.mock('child_process', () => ({ execFileSync }))

const {
  extractHealPrompt,
  buildAgentCommand,
  failureSignature,
  loadPrompt,
  spawnHealAgent,
  isAgentCliAvailable,
  healAgentBanner,
  closeLastHealAgentTab,
  buildBaselineVanillaPrompt,
  buildStartupFailurePrompt,
} = await import('./auto-heal')

beforeEach(() => {
  openItermTabs.mockClear()
  openItermTabs.mockReturnValue(['SID-1'])
  reuseItermTabs.mockClear()
  reuseItermTabs.mockReturnValue(false)
  closeItermSessionsByPrefix.mockClear()
  closeItermSessionsByIds.mockClear()
  openTerminalTabs.mockClear()
  closeTerminalTabsByPrefix.mockClear()
  execFileSync.mockReset()
  execFileSync.mockImplementation(() => '')
  // Clean signal files between tests.
  for (const f of [RERUN_SIGNAL, RESTART_SIGNAL, path.join(LOGS_DIR, '.heal-agent-done')]) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* ignore */
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
  while (tmpDirs.length > 1) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('extractHealPrompt', () => {
  const START = '<!-- heal-prompt:start -->'
  const END = '<!-- heal-prompt:end -->'

  it('returns the content between markers, trimmed', () => {
    const src = `# Project Notes\n\n${START}\n\nhello world\n\n${END}\n\nother stuff`
    expect(extractHealPrompt(src)).toBe('hello world')
  })

  it('returns null when either marker is missing', () => {
    expect(extractHealPrompt('no markers at all')).toBeNull()
    expect(extractHealPrompt(`only ${START} here`)).toBeNull()
    expect(extractHealPrompt(`only ${END} here`)).toBeNull()
  })

  it('returns null when end precedes start', () => {
    expect(extractHealPrompt(`${END}\nbody\n${START}`)).toBeNull()
  })

  it('handles an empty body between markers', () => {
    expect(extractHealPrompt(`${START}${END}`)).toBe('')
  })
})

describe('buildAgentCommand', () => {
  it('claude + new session does NOT pass --model (defers to user CLI profile)', () => {
    const cmd = buildAgentCommand('claude', 'new', 0, '/tmp/p.txt')
    expect(cmd).toContain('claude --dangerously-skip-permissions')
    expect(cmd).toContain('--output-format=stream-json --verbose -p')
    expect(cmd).not.toContain('--model')
    expect(cmd).not.toContain('--continue')
    expect(cmd).toContain('"$(cat "/tmp/p.txt")"')
    expect(cmd).toContain('claude-formatter.js')
  })

  it('claude + resume (cycle > 0) adds --continue before the base flags', () => {
    const cmd = buildAgentCommand('claude', 'resume', 2, '/tmp/p.txt')
    expect(cmd).toContain('--continue --dangerously-skip-permissions')
  })

  it('claude + resume on cycle 0 does NOT use --continue', () => {
    const cmd = buildAgentCommand('claude', 'resume', 0, '/tmp/p.txt')
    expect(cmd).not.toContain('--continue')
  })

  it('codex + new session does NOT pass -m or reasoning effort (defers to user CLI profile)', () => {
    const cmd = buildAgentCommand('codex', 'new', 0, '/tmp/p.txt')
    expect(cmd).toContain(
      'codex exec --skip-git-repo-check --full-auto --json',
    )
    expect(cmd).not.toContain('-m ')
    expect(cmd).not.toContain('model_reasoning_effort')
    expect(cmd).not.toContain('codex exec resume')
    expect(cmd).toContain('codex-formatter.js')
  })

  it('codex + resume wraps resume || exec fallback', () => {
    const cmd = buildAgentCommand('codex', 'resume', 1, '/tmp/p.txt')
    expect(cmd).toContain('codex exec resume --skip-git-repo-check --full-auto --json')
    expect(cmd).toContain('|| codex exec --skip-git-repo-check --full-auto --json')
  })

  it('does not persist the raw agent stream to disk', () => {
    const claudeCmd = buildAgentCommand('claude', 'new', 0, '/tmp/p.txt')
    const codexCmd = buildAgentCommand('codex', 'resume', 1, '/tmp/p.txt')
    expect(claudeCmd).not.toContain('tee ')
    expect(codexCmd).not.toContain('tee ')
    expect(claudeCmd).not.toMatch(/heal-.*-raw-.*\.jsonl/)
    expect(codexCmd).not.toMatch(/heal-.*-raw-.*\.jsonl/)
  })
})

describe('healAgentBanner', () => {
  it('claude banner notes CLI profile defaults are used', () => {
    expect(healAgentBanner('claude')).toBe(
      '[canary-lab] heal agent — claude (using your CLI profile defaults for model + reasoning)',
    )
  })

  it('codex banner notes CLI profile defaults are used', () => {
    expect(healAgentBanner('codex')).toBe(
      '[canary-lab] heal agent — codex (using your CLI profile defaults for model + reasoning)',
    )
  })
})

describe('failureSignature', () => {
  it('returns empty string for non-arrays', () => {
    expect(failureSignature(null)).toBe('')
    expect(failureSignature(undefined)).toBe('')
    expect(failureSignature('not-array')).toBe('')
    expect(failureSignature({ name: 'x' })).toBe('')
  })

  it('joins string entries sorted', () => {
    expect(failureSignature(['b', 'a', 'c'])).toBe('a|b|c')
  })

  it('extracts .name from object entries', () => {
    expect(failureSignature([{ name: 'foo' }, { name: 'bar' }])).toBe('bar|foo')
  })

  it('mixes strings and objects; ignores entries without name', () => {
    expect(failureSignature(['z', { name: 'a' }, { notName: 'x' }, null])).toBe('a|z')
  })

  it('is stable for reordered inputs (sorted)', () => {
    expect(failureSignature(['a', 'b'])).toBe(failureSignature(['b', 'a']))
  })
})

describe('loadPrompt', () => {
  it('extracts content between <!-- heal-prompt:start/end --> markers, trimmed', () => {
    const dir = mkTmp()
    const p = path.join(dir, 'CLAUDE.md')
    fs.writeFileSync(
      p,
      '# Project Notes\n\n<!-- heal-prompt:start -->\n\nhello\n\n<!-- heal-prompt:end -->\n\nmore stuff\n',
    )
    expect(loadPrompt('claude', p)).toBe('hello')
  })

  it('throws a helpful error when the source file is missing', () => {
    expect(() => loadPrompt('claude', '/does/not/exist.md')).toThrow(/Heal prompt source not found/)
  })

  it('throws when markers are missing from the source file', () => {
    const dir = mkTmp()
    const p = path.join(dir, 'CLAUDE.md')
    fs.writeFileSync(p, '# Project Notes\n\nno markers here\n')
    expect(() => loadPrompt('claude', p)).toThrow(/Heal prompt markers/)
  })
})

describe('isAgentCliAvailable', () => {
  it('returns true when `which <agent>` succeeds', () => {
    execFileSync.mockImplementation(() => '')
    expect(isAgentCliAvailable('claude')).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('which', ['claude'], { stdio: 'ignore' })
  })

  it('returns false when `which <agent>` throws', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('not found')
    })
    expect(isAgentCliAvailable('codex')).toBe(false)
  })
})

describe('spawnHealAgent', () => {
  function seedPrompt(agent: 'claude' | 'codex') {
    const file = agent === 'claude'
      ? path.join(pathStubRoot, 'CLAUDE.md')
      : path.join(pathStubRoot, 'AGENTS.md')
    fs.writeFileSync(
      file,
      '# Project Notes\n\n<!-- heal-prompt:start -->\ngo heal\n<!-- heal-prompt:end -->\n',
    )
  }

  it('writes prompt + heal script to LOGS_DIR, opens iTerm tab, returns "signal" when RERUN_SIGNAL appears', async () => {
    seedPrompt('claude')
    vi.useFakeTimers()

    const promise = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'iTerm',
    })

    // Simulate the heal agent writing the rerun signal.
    fs.writeFileSync(RERUN_SIGNAL, '')

    await vi.advanceTimersByTimeAsync(1200)
    expect(await promise).toBe('signal')

    // Prompt + script files were written.
    const promptFile = path.join(LOGS_DIR, '.heal-prompt.txt')
    const scriptFile = path.join(LOGS_DIR, '.heal-agent.sh')
    expect(fs.readFileSync(promptFile, 'utf-8')).toBe('go heal')
    const script = fs.readFileSync(scriptFile, 'utf-8')
    expect(script).toContain('claude --dangerously-skip-permissions')
    expect(script).toContain('#!/bin/bash')
    expect(script).toMatch(/heal agent — .*claude/)
    expect(script).toContain('using your CLI profile defaults for model + reasoning')

    // iTerm boundary was invoked; Terminal boundary was not.
    expect(openItermTabs).toHaveBeenCalledOnce()
    const [tabs, label] = openItermTabs.mock.calls[0]
    expect(tabs).toEqual([
      expect.objectContaining({
        dir: pathStubRoot,
        command: expect.stringMatching(/^bash .*\.heal-agent\.sh$/),
        name: 'heal-agent-claude-1',
      }),
    ])
    expect(label).toContain('iTerm')
    expect(closeItermSessionsByPrefix).toHaveBeenCalledWith(['heal-agent-'])
    expect(openTerminalTabs).not.toHaveBeenCalled()
  })

  it('uses vanilla baseline prompt (not the heal skill) when benchmarkMode is baseline', async () => {
    // Intentionally do NOT seed CLAUDE.md heal-prompt markers — baseline must
    // not depend on the canary-lab heal workflow existing or being readable.
    vi.useFakeTimers()

    const promise = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'iTerm',
      benchmarkMode: 'baseline',
      baselinePlaywrightLogPath: '/tmp/sandbox/playwright-stdout.log',
      baselineSignalFilePath: '/project/logs/.restart',
      baselineRepoPaths: ['/repos/app', '/repos/svc'],
      agentCwd: '/tmp/sandbox',
    })

    fs.writeFileSync(RESTART_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1200)
    expect(await promise).toBe('signal')

    const prompt = fs.readFileSync(path.join(LOGS_DIR, '.heal-prompt.txt'), 'utf-8')
    // Absolute paths so the sandboxed agent can reach the real workspace.
    expect(prompt).toContain('/tmp/sandbox/playwright-stdout.log')
    expect(prompt).toContain('/project/logs/.restart')
    expect(prompt).toContain('/repos/app')
    expect(prompt).toContain('/repos/svc')
    // Must not leak canary-lab methodology into baseline.
    expect(prompt).not.toContain('diagnosis-journal')
    expect(prompt).not.toContain('failed[].logs')
    expect(prompt).not.toContain('e2e-summary.json')
    expect(prompt).not.toContain('heal-index')
    // iTerm tab was opened with the sandbox cwd, not ROOT.
    const [tabs] = openItermTabs.mock.calls[0]
    expect(tabs[0].dir).toBe('/tmp/sandbox')
  })

  it('falls back to default playwright log path and restart signal when baseline options are omitted', async () => {
    vi.useFakeTimers()

    const promise = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'iTerm',
      benchmarkMode: 'baseline',
    })

    fs.writeFileSync(RESTART_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1200)
    await promise

    const prompt = fs.readFileSync(path.join(LOGS_DIR, '.heal-prompt.txt'), 'utf-8')
    // Defaults: playwright-stdout.log inside LOGS_DIR and RESTART_SIGNAL.
    expect(prompt).toContain(path.join(LOGS_DIR, 'playwright-stdout.log'))
    expect(prompt).toContain(RESTART_SIGNAL)
  })

  it('buildStartupFailurePrompt embeds the service, URL, log, repo, and signal paths', () => {
    const prompt = buildStartupFailurePrompt({
      serviceName: 'swc-coverage-3003',
      healthUrl: 'http://localhost:3003/en_SG/trace-test',
      logPath: '/abs/logs/svc-swc-coverage-3003.log',
      repoPath: '/abs/repos/nextjs-logger-research',
      restartSignalPath: '/abs/logs/.restart',
    })
    expect(prompt).toContain('swc-coverage-3003')
    expect(prompt).toContain('http://localhost:3003/en_SG/trace-test')
    expect(prompt).toContain('/abs/logs/svc-swc-coverage-3003.log')
    expect(prompt).toContain('/abs/repos/nextjs-logger-research')
    expect(prompt).toContain('/abs/logs/.restart')
    // Must steer the agent away from test/config edits and process-killing.
    expect(prompt).toContain('never canary-lab test/config')
    expect(prompt).toContain('Do not kill the service process')
    expect(prompt).toContain('filesChanged')
  })

  it('uses basePromptOverride instead of reading CLAUDE.md when set', async () => {
    // Intentionally do NOT seed CLAUDE.md — the override must be used instead.
    vi.useFakeTimers()

    const promise = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'iTerm',
      basePromptOverride: 'STARTUP FAILURE PROMPT — use me, not CLAUDE.md',
    })

    fs.writeFileSync(RESTART_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1200)
    await promise

    const prompt = fs.readFileSync(path.join(LOGS_DIR, '.heal-prompt.txt'), 'utf-8')
    expect(prompt).toBe('STARTUP FAILURE PROMPT — use me, not CLAUDE.md')
  })

  it('basePromptOverride is ignored when benchmarkMode is baseline', async () => {
    vi.useFakeTimers()

    const promise = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'iTerm',
      benchmarkMode: 'baseline',
      basePromptOverride: 'should not appear',
    })

    fs.writeFileSync(RESTART_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1200)
    await promise

    const prompt = fs.readFileSync(path.join(LOGS_DIR, '.heal-prompt.txt'), 'utf-8')
    expect(prompt).not.toContain('should not appear')
    // Baseline prompt still written.
    expect(prompt).toContain('Playwright tests just failed')
  })

  it('buildBaselineVanillaPrompt formats absolute paths and optional repo list', () => {
    const withRepos = buildBaselineVanillaPrompt({
      playwrightLogPath: '/abs/log.log',
      signalFilePath: '/abs/.restart',
      repoPaths: ['/repos/a'],
    })
    expect(withRepos).toContain('/abs/log.log')
    expect(withRepos).toContain('/abs/.restart')
    expect(withRepos).toContain('/repos/a')
    expect(withRepos).toContain('Repositories you may need to edit')

    const withoutRepos = buildBaselineVanillaPrompt({
      playwrightLogPath: '/abs/log.log',
      signalFilePath: '/abs/.restart',
    })
    expect(withoutRepos).not.toContain('Repositories you may need to edit')
  })

  it('appends prompt addendum and benchmark usage env when provided', async () => {
    seedPrompt('codex')
    vi.useFakeTimers()
    const usageFile = path.join(LOGS_DIR, 'benchmark', 'usage', 'cycle-1.jsonl')

    const promise = spawnHealAgent({
      agent: 'codex',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'Terminal',
      promptAddendum: 'Benchmark override: use only the Playwright failure summary.',
      benchmarkUsageFile: usageFile,
    })

    fs.writeFileSync(RESTART_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1200)
    await promise

    expect(fs.readFileSync(path.join(LOGS_DIR, '.heal-prompt.txt'), 'utf-8')).toContain(
      'Benchmark override: use only the Playwright failure summary.',
    )
    const script = fs.readFileSync(path.join(LOGS_DIR, '.heal-agent.sh'), 'utf-8')
    expect(script).toContain('CANARY_LAB_BENCHMARK_USAGE_FILE')
    expect(script).toContain(usageFile)
  })

  it('returns "signal" when RESTART_SIGNAL appears', async () => {
    seedPrompt('codex')
    vi.useFakeTimers()

    const promise = spawnHealAgent({
      agent: 'codex',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'Terminal',
    })

    fs.writeFileSync(RESTART_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1200)
    expect(await promise).toBe('signal')

    expect(openTerminalTabs).toHaveBeenCalledOnce()
    expect(closeTerminalTabsByPrefix).toHaveBeenCalledWith(['heal-agent-'])
    expect(openItermTabs).not.toHaveBeenCalled()
  })

  it('returns "agent_exited_no_signal" when heal-done appears and grace elapses with no signal', async () => {
    seedPrompt('claude')
    vi.useFakeTimers()

    const promise = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'iTerm',
    })

    // Tick once; then agent writes "done".
    await vi.advanceTimersByTimeAsync(1000)
    fs.writeFileSync(path.join(LOGS_DIR, '.heal-agent-done'), '0')

    // Advance past the 5s grace window.
    await vi.advanceTimersByTimeAsync(6000)
    expect(await promise).toBe('agent_exited_no_signal')
  })

  it('reuses the previous iTerm heal tab on subsequent cycle when reuseItermTabs succeeds', async () => {
    seedPrompt('claude')
    vi.useFakeTimers()

    openItermTabs.mockReturnValueOnce(['prev-id-999'])
    const p1 = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'iTerm',
    })
    fs.writeFileSync(RERUN_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1200)
    await p1
    fs.unlinkSync(RERUN_SIGNAL)

    openItermTabs.mockClear()
    closeItermSessionsByIds.mockClear()
    closeItermSessionsByPrefix.mockClear()
    reuseItermTabs.mockClear()
    reuseItermTabs.mockReturnValueOnce(true) // reuse succeeded → fallback skipped

    const p2 = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'resume',
      cycle: 1,
      terminal: 'iTerm',
    })
    fs.writeFileSync(RERUN_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1200)
    await p2

    expect(reuseItermTabs).toHaveBeenCalledOnce()
    const [ids, tabs] = reuseItermTabs.mock.calls[0]
    expect(ids).toEqual(['prev-id-999'])
    expect(tabs).toEqual([
      expect.objectContaining({ name: 'heal-agent-claude-2' }),
    ])
    expect(openItermTabs).not.toHaveBeenCalled()
    expect(closeItermSessionsByIds).not.toHaveBeenCalled()
    expect(closeItermSessionsByPrefix).not.toHaveBeenCalled()
  })

  it('closes previous iTerm session IDs on subsequent cycle', async () => {
    seedPrompt('claude')
    vi.useFakeTimers()

    // Cycle 0 — captures id.
    openItermTabs.mockReturnValueOnce(['prev-id-123'])
    const p1 = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'iTerm',
    })
    fs.writeFileSync(RERUN_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1200)
    await p1

    // Clear signal so the next cycle doesn't exit immediately.
    fs.unlinkSync(RERUN_SIGNAL)
    closeItermSessionsByIds.mockClear()

    // Cycle 1 — should close the prior SID.
    const p2 = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'resume',
      cycle: 1,
      terminal: 'iTerm',
    })
    fs.writeFileSync(RERUN_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1200)
    await p2

    expect(closeItermSessionsByIds).toHaveBeenCalledWith(['prev-id-123'])
  })

  it('returns "timeout" when deadline elapses with no signal or done file', async () => {
    seedPrompt('claude')
    vi.useFakeTimers()

    const promise = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'iTerm',
    })

    // Advance past the 10 min AGENT_TIMEOUT_MS deadline.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 2000)
    expect(await promise).toBe('timeout')
  })
})

describe('closeLastHealAgentTab', () => {
  it('persists cleared state to disk even when closeItermSessionsByIds throws', async () => {
    fs.writeFileSync(
      path.join(pathStubRoot, 'CLAUDE.md'),
      '# Project Notes\n\n<!-- heal-prompt:start -->\ngo heal\n<!-- heal-prompt:end -->\n',
    )

    vi.useFakeTimers()
    openItermTabs.mockReturnValueOnce(['seed-sid-xyz'])
    const p = spawnHealAgent({
      agent: 'claude',
      sessionMode: 'new',
      cycle: 0,
      terminal: 'iTerm',
    })
    fs.writeFileSync(RERUN_SIGNAL, '')
    await vi.advanceTimersByTimeAsync(1200)
    await p
    vi.useRealTimers()
    fs.unlinkSync(RERUN_SIGNAL)

    closeItermSessionsByIds.mockClear()
    closeItermSessionsByIds.mockImplementationOnce(() => {
      throw new Error('boom')
    })

    // try/finally (no catch): error propagates, but saveHealIds in finally
    // still runs after the .splice(0) cleared the in-memory state.
    expect(() => closeLastHealAgentTab()).toThrow('boom')
    expect(closeItermSessionsByIds).toHaveBeenCalledWith(['seed-sid-xyz'])

    const saved = JSON.parse(fs.readFileSync(ITERM_HEAL_SESSION_IDS_PATH, 'utf-8'))
    expect(saved).toEqual([])
  })

  it('no-ops silently when no previous heal tab IDs', () => {
    // Depends on the preceding test draining module-level previousHealAgentIds via .splice(0).
    closeItermSessionsByIds.mockClear()
    expect(() => closeLastHealAgentTab()).not.toThrow()
    expect(closeItermSessionsByIds).not.toHaveBeenCalled()
  })
})
