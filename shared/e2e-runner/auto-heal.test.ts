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

vi.mock('./paths', () => ({
  ROOT: pathStubRoot,
  LOGS_DIR,
  RERUN_SIGNAL,
  RESTART_SIGNAL,
}))

const openItermTabs = vi.fn(() => ['SID-1'])
const closeItermSessionsByPrefix = vi.fn()
const closeItermSessionsByIds = vi.fn()
vi.mock('../launcher/iterm', () => ({
  openItermTabs,
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
} = await import('./auto-heal')

beforeEach(() => {
  openItermTabs.mockClear()
  openItermTabs.mockReturnValue(['SID-1'])
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
  it('claude + new session', () => {
    const cmd = buildAgentCommand('claude', 'new', 0, '/tmp/p.txt')
    expect(cmd).toContain('claude --dangerously-skip-permissions')
    expect(cmd).toContain('--output-format=stream-json --verbose -p')
    expect(cmd).not.toContain('--continue')
    expect(cmd).toContain('"$(cat "/tmp/p.txt")"')
    expect(cmd).toContain('heal-formatter.js')
  })

  it('claude + resume (cycle > 0) adds --continue', () => {
    const cmd = buildAgentCommand('claude', 'resume', 2, '/tmp/p.txt')
    expect(cmd).toContain('--continue --dangerously-skip-permissions')
  })

  it('claude + resume on cycle 0 does NOT use --continue', () => {
    const cmd = buildAgentCommand('claude', 'resume', 0, '/tmp/p.txt')
    expect(cmd).not.toContain('--continue')
  })

  it('codex + new session', () => {
    const cmd = buildAgentCommand('codex', 'new', 0, '/tmp/p.txt')
    expect(cmd).toContain('codex exec --skip-git-repo-check --full-auto --json')
    expect(cmd).not.toContain('codex exec resume')
    expect(cmd).toContain('codex-formatter.js')
  })

  it('codex + resume wraps resume || exec fallback', () => {
    const cmd = buildAgentCommand('codex', 'resume', 1, '/tmp/p.txt')
    expect(cmd).toContain('codex exec resume --skip-git-repo-check --full-auto --json')
    expect(cmd).toContain('|| codex exec --skip-git-repo-check --full-auto --json')
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
})
