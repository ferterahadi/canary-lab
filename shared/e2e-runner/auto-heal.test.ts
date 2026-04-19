import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

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

const openItermTabs = vi.fn(() => ['SID-1'])
const reuseItermTabs = vi.fn(() => false)
const closeItermSessionsByPrefix = vi.fn()
const closeItermSessionsByIds = vi.fn()
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
  stripFrontmatter,
  buildAgentCommand,
  failureSignature,
  loadPrompt,
  spawnHealAgent,
  isAgentCliAvailable,
  healAgentBanner,
  closeLastHealAgentTab,
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

describe('stripFrontmatter', () => {
  it('strips a leading --- ... --- block', () => {
    const src = '---\nname: x\ndesc: y\n---\nbody line 1\nbody line 2\n'
    expect(stripFrontmatter(src)).toBe('body line 1\nbody line 2\n')
  })

  it('returns content unchanged when no leading frontmatter', () => {
    expect(stripFrontmatter('# heading\nbody')).toBe('# heading\nbody')
  })

  it('returns content unchanged when opening --- has no closing', () => {
    expect(stripFrontmatter('---\nunterminated')).toBe('---\nunterminated')
  })

  it('returns empty when frontmatter is the entire file', () => {
    expect(stripFrontmatter('---\na: b\n---')).toBe('')
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
  it('reads and strips frontmatter, trimmed', () => {
    const dir = mkTmp()
    const p = path.join(dir, 'prompt.md')
    fs.writeFileSync(p, '---\nname: x\n---\n\nhello\n\n')
    expect(loadPrompt('claude', p)).toBe('hello')
  })

  it('throws a helpful error when prompt file missing', () => {
    expect(() => loadPrompt('claude', '/does/not/exist.md')).toThrow(/Heal prompt not found/)
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
    const dir = agent === 'claude'
      ? path.join(pathStubRoot, '.claude', 'skills')
      : path.join(pathStubRoot, '.codex')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'heal-loop.md'), '---\nname: x\n---\ngo heal\n')
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
    expect(script).toContain(
      '[canary-lab] heal agent — claude (using your CLI profile defaults for model + reasoning)',
    )

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
    const seedDir = path.join(pathStubRoot, '.claude', 'skills')
    fs.mkdirSync(seedDir, { recursive: true })
    fs.writeFileSync(path.join(seedDir, 'heal-loop.md'), '---\nname: x\n---\ngo heal\n')

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
