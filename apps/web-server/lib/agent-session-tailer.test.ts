import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from './agent-session-log'
import {
  locatorForAgentInDir,
  refForAgentSpawn,
  tailAgentSession,
} from './agent-session-tailer'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-test-'))
})
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

// Wait for `predicate()` to return true, polling every `interval` ms.
function until(predicate: () => boolean, timeout = 1000, interval = 25): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeout) return reject(new Error('until: timeout'))
      setTimeout(check, interval)
    }
    check()
  })
}

// Build a claude JSONL line as the agent CLI would write it.
function claudeLine(text: string, ts = '2025-01-01T00:00:00Z'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { content: [{ type: 'text', text }] },
  })
}

describe('refForAgentSpawn', () => {
  it('builds a deterministic claude log path from cwd + session id', () => {
    const ref = refForAgentSpawn({ agent: 'claude', cwd: '/Users/x/proj', sessionId: 'abc' })
    expect(ref.agent).toBe('claude')
    expect(ref.sessionId).toBe('abc')
    // /Users/x/proj → -Users-x-proj. HOME is OS-specific; just match suffix.
    expect(ref.logPath.endsWith(path.join('.claude', 'projects', '-Users-x-proj', 'abc.jsonl'))).toBe(true)
  })

  it('returns a placeholder ref for codex (no pin)', () => {
    const ref = refForAgentSpawn({ agent: 'codex', cwd: '/x' })
    expect(ref.agent).toBe('codex')
    expect(ref.logPath).toBe('')
    expect(ref.sessionId).toBe('')
  })

  it('returns a placeholder ref for claude when no session id is provided', () => {
    const ref = refForAgentSpawn({ agent: 'claude', cwd: '/x' })
    expect(ref.logPath).toBe('')
  })

  it('falls back to an empty home when $HOME is unset', () => {
    const original = process.env.HOME
    delete process.env.HOME
    try {
      const ref = refForAgentSpawn({ agent: 'claude', cwd: '/p', sessionId: 'abc' })
      // With no HOME, the path is relative — just verify the suffix.
      expect(ref.logPath.endsWith(path.join('.claude', 'projects', '-p', 'abc.jsonl'))).toBe(true)
    } finally {
      process.env.HOME = original
    }
  })
})

describe('tailAgentSession', () => {
  it('emits all existing events on attach', async () => {
    const logPath = path.join(tmp, 's.jsonl')
    fs.writeFileSync(logPath, claudeLine('first') + '\n' + claudeLine('second') + '\n', 'utf-8')
    const events: AgentEvent[] = []
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: 's', logPath },
      onEvent: (e) => events.push(e),
    })
    await until(() => events.length === 2)
    handle.close()
    expect(events.map((e) => e.kind === 'assistant-message' ? e.text : '')).toEqual(['first', 'second'])
  })

  it('emits new events as the file is appended', async () => {
    const logPath = path.join(tmp, 's.jsonl')
    fs.writeFileSync(logPath, claudeLine('one') + '\n', 'utf-8')
    const events: AgentEvent[] = []
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: 's', logPath },
      onEvent: (e) => events.push(e),
    })
    await until(() => events.length === 1)
    fs.appendFileSync(logPath, claudeLine('two') + '\n')
    await until(() => events.length === 2)
    handle.close()
    expect(events).toHaveLength(2)
  })

  it('does not emit when the file has no newline yet', async () => {
    const logPath = path.join(tmp, 's.jsonl')
    fs.writeFileSync(logPath, claudeLine('partial'), 'utf-8') // no trailing \n
    const events: AgentEvent[] = []
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: 's', logPath },
      onEvent: (e) => events.push(e),
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(events).toHaveLength(0)
    handle.close()
  })

  it('handles a partial trailing line by re-reading once it is terminated', async () => {
    const logPath = path.join(tmp, 's.jsonl')
    fs.writeFileSync(logPath, claudeLine('a') + '\n', 'utf-8')
    const events: AgentEvent[] = []
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: 's', logPath },
      onEvent: (e) => events.push(e),
    })
    await until(() => events.length === 1)
    const partial = claudeLine('b')
    fs.appendFileSync(logPath, partial) // no trailing newline yet
    await new Promise((r) => setTimeout(r, 50))
    expect(events).toHaveLength(1) // partial line not yet emitted
    fs.appendFileSync(logPath, '\n')
    await until(() => events.length === 2)
    handle.close()
  })

  it('uses discoverRef when the initial logPath does not exist', async () => {
    const realPath = path.join(tmp, 'real.jsonl')
    const events: AgentEvent[] = []
    let discovered = false
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: '', logPath: '' },
      onEvent: (e) => events.push(e),
      discoverRef: () => {
        if (!fs.existsSync(realPath)) return null
        discovered = true
        return { agent: 'claude', sessionId: 's', logPath: realPath }
      },
    })
    // No file yet — nothing emitted.
    await new Promise((r) => setTimeout(r, 80))
    expect(events).toHaveLength(0)
    fs.writeFileSync(realPath, claudeLine('hi') + '\n')
    await until(() => events.length === 1, 5000, 100)
    handle.close()
    expect(discovered).toBe(true)
  })

  it('close() stops the watcher and discovery loop', async () => {
    const logPath = path.join(tmp, 'never.jsonl')
    const events: AgentEvent[] = []
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: '', logPath },
      onEvent: (e) => events.push(e),
    })
    handle.close()
    // Even if a file appears later, the closed tailer should not pick it up.
    fs.writeFileSync(logPath, claudeLine('late') + '\n')
    await new Promise((r) => setTimeout(r, 80))
    expect(events).toHaveLength(0)
  })

  it('reports a give-up error after pollMaxAttempts discovery failures', async () => {
    const events: AgentEvent[] = []
    const errors: string[] = []
    const handle = tailAgentSession({
      ref: { agent: 'codex', sessionId: '', logPath: path.join(tmp, 'missing.jsonl') },
      onEvent: (e) => events.push(e),
      onError: (e) => errors.push(e.message),
      discoverRef: () => null,
      pollIntervalMs: 1,
      pollMaxAttempts: 2,
    })
    await until(() => errors.length > 0)
    handle.close()
    expect(events).toHaveLength(0)
    expect(errors[0]).toMatch(/gave up waiting/)
  })

  it('keeps tailing when onError is omitted and an error occurs', async () => {
    const handle = tailAgentSession({
      ref: { agent: 'codex', sessionId: '', logPath: path.join(tmp, 'missing.jsonl') },
      onEvent: () => {},
      discoverRef: () => null,
      pollIntervalMs: 1,
      pollMaxAttempts: 1,
    })
    await new Promise((r) => setTimeout(r, 30))
    handle.close()
    // No throw is the assertion.
    expect(true).toBe(true)
  })

  it('swallows errors raised by onEvent so the tailer keeps running', async () => {
    const logPath = path.join(tmp, 's.jsonl')
    fs.writeFileSync(logPath, claudeLine('one') + '\n', 'utf-8')
    let calls = 0
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: 's', logPath },
      onEvent: () => {
        calls += 1
        throw new Error('subscriber boom')
      },
    })
    await until(() => calls === 1)
    fs.appendFileSync(logPath, claudeLine('two') + '\n')
    await until(() => calls === 2)
    handle.close()
  })

  it('reports errors when fs.watch fails to attach', async () => {
    const logPath = path.join(tmp, 's.jsonl')
    fs.writeFileSync(logPath, claudeLine('first') + '\n', 'utf-8')
    const spy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('watch boom')
    })
    const errors: string[] = []
    try {
      const handle = tailAgentSession({
        ref: { agent: 'claude', sessionId: 's', logPath },
        onEvent: () => {},
        onError: (e) => errors.push(e.message),
      })
      await until(() => errors.length === 1)
      handle.close()
    } finally {
      spy.mockRestore()
    }
    expect(errors[0]).toMatch(/watch boom/)
  })

  it('reports errors when reading the appended tail fails', async () => {
    const logPath = path.join(tmp, 's.jsonl')
    fs.writeFileSync(logPath, claudeLine('first') + '\n', 'utf-8')
    const errors: string[] = []
    let calls = 0
    const original = fs.openSync
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      calls += 1
      if (calls >= 2) throw new Error('open boom')
      return original(...args)
    }) as typeof fs.openSync)
    try {
      const handle = tailAgentSession({
        ref: { agent: 'claude', sessionId: 's', logPath },
        onEvent: () => {},
        onError: (e) => errors.push(e.message),
      })
      await new Promise((r) => setTimeout(r, 30))
      fs.appendFileSync(logPath, claudeLine('two') + '\n')
      await until(() => errors.length >= 1)
      handle.close()
    } finally {
      spy.mockRestore()
    }
    expect(errors[0]).toMatch(/open boom/)
  })

  it('swallows errors raised by onError', async () => {
    const handle = tailAgentSession({
      ref: { agent: 'codex', sessionId: '', logPath: path.join(tmp, 'missing.jsonl') },
      onEvent: () => {},
      onError: () => { throw new Error('subscriber boom') },
      discoverRef: () => null,
      pollIntervalMs: 1,
      pollMaxAttempts: 1,
    })
    await new Promise((r) => setTimeout(r, 30))
    handle.close()
    expect(true).toBe(true)
  })
})

describe('locatorForAgentInDir', () => {
  it('returns null when no session log exists for the dir', () => {
    const locator = locatorForAgentInDir('claude', path.join(tmp, 'no-such-cwd'))
    expect(locator()).toBeNull()
  })

  it('returns the located ref when no spawnedAt floor is supplied', () => {
    const home = path.join(tmp, 'home1')
    const cwd = path.join(tmp, 'cwd1')
    seedClaudeLog(home, cwd)
    withHome(home, () => {
      const locator = locatorForAgentInDir('claude', cwd)
      const ref = locator()
      expect(ref?.agent).toBe('claude')
    })
  })

  it('returns the located ref when the log is newer than spawnedAt', () => {
    const home = path.join(tmp, 'home2')
    const cwd = path.join(tmp, 'cwd2')
    seedClaudeLog(home, cwd)
    // Use a spawnedAt well before now so the freshly-written log passes.
    const earlySpawnedAt = new Date(Date.now() - 60_000).toISOString()
    withHome(home, () => {
      const locator = locatorForAgentInDir('claude', cwd, earlySpawnedAt)
      expect(locator()?.agent).toBe('claude')
    })
  })

  it('skips logs older than the spawnedAt floor', () => {
    const home = path.join(tmp, 'home3')
    const cwd = path.join(tmp, 'cwd3')
    const logPath = seedClaudeLog(home, cwd)
    const longAgo = new Date('2000-01-01').getTime() / 1000
    fs.utimesSync(logPath, longAgo, longAgo)
    withHome(home, () => {
      const locator = locatorForAgentInDir('claude', cwd, new Date().toISOString())
      expect(locator()).toBeNull()
    })
  })

  it('returns null when stat throws for the located log', () => {
    const home = path.join(tmp, 'home4')
    const cwd = path.join(tmp, 'cwd4')
    const logPath = seedClaudeLog(home, cwd)
    // Remove the file between locate-and-stat to force a throw inside the
    // mtime check branch. The locator opens the dir first (succeeds) and
    // then stats the file (fails).
    fs.unlinkSync(logPath)
    withHome(home, () => {
      const locator = locatorForAgentInDir('claude', cwd, new Date().toISOString())
      expect(locator()).toBeNull()
    })
  })
})

function seedClaudeLog(home: string, cwd: string): string {
  const encoded = cwd.replace(/\//g, '-')
  const dir = path.join(home, '.claude', 'projects', encoded)
  fs.mkdirSync(dir, { recursive: true })
  const logPath = path.join(dir, 'session.jsonl')
  fs.writeFileSync(logPath, claudeLine('seed') + '\n')
  return logPath
}

function withHome(home: string, fn: () => void): void {
  const original = process.env.HOME
  process.env.HOME = home
  try { fn() } finally { process.env.HOME = original }
}
