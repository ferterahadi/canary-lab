// Separate test file for onChunk coverage — uses vi.mock('child_process') at
// module level (hoisted) so the fake spawn can emit data events before close.
// Cannot be merged with agent.test.ts because that file uses real stub binaries
// on PATH; module-level vi.mock would intercept all spawn calls there too.

import { vi, describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ── mock setup ──────────────────────────────────────────────────────────────

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mockSpawn, default: { spawn: mockSpawn } }))

// ── helpers ──────────────────────────────────────────────────────────────────

interface FakeChildOpts {
  stdout?: string | Buffer
  stderr?: string | Buffer
  exitCode?: number
}

function makeFakeChild(opts: FakeChildOpts = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: () => boolean
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => false
  setTimeout(() => {
    if (opts.stdout) child.stdout.emit('data', typeof opts.stdout === 'string' ? Buffer.from(opts.stdout) : opts.stdout)
    if (opts.stderr) child.stderr.emit('data', typeof opts.stderr === 'string' ? Buffer.from(opts.stderr) : opts.stderr)
    child.emit('close', opts.exitCode ?? 0)
  }, 0)
  return child
}

const roots: string[] = []
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-onchunk-'))
  roots.push(d)
  return d
}
afterEach(() => {
  mockSpawn.mockReset()
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})

// Import AFTER vi.mock so the hoisted mock is in place.
import { runPortifyAgent, isAgentSessionLimited } from './agent'

// ── tests ────────────────────────────────────────────────────────────────────

describe('runPortifyAgent — onChunk coverage', () => {
  it('writes stdout chunk to log file when logPath is provided (out !== null TRUE branch)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ stdout: 'hello from agent\n' }))
    const dir = tmp()
    const logPath = path.join(dir, 'portify-out.log')
    await runPortifyAgent({ agent: 'claude', prompt: 'go', cwd: dir, logPath })
    const written = fs.readFileSync(logPath, 'utf-8')
    expect(written).toContain('hello from agent')
  })

  it('skips writeSync when no logPath — out is null (out !== null FALSE branch)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ stdout: 'output no log\n', stderr: 'err no log\n' }))
    const dir = tmp()
    // No logPath → out stays null → onChunk skips writeSync, no throw
    await expect(runPortifyAgent({ agent: 'claude', prompt: 'go', cwd: dir })).resolves.toBeUndefined()
  })

  it('swallows writeSync errors in onChunk (catch block)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({ stdout: 'chunk\n' }))
    const writeSyncSpy = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => { throw new Error('disk full') })
    const dir = tmp()
    const logPath = path.join(dir, 'portify-err.log')
    await expect(runPortifyAgent({ agent: 'claude', prompt: 'go', cwd: dir, logPath })).resolves.toBeUndefined()
    writeSyncSpy.mockRestore()
  })

  it('rejects with a session-limit message when the agent reports quota exhaustion (exit 0, no edits)', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({
      stdout: '{"type":"assistant","message":{"content":[{"type":"text","text":"You\'ve hit your session limit · resets 6:30pm"}]}}\n',
      exitCode: 0,
    }))
    const dir = tmp()
    await expect(runPortifyAgent({ agent: 'claude', prompt: 'go', cwd: dir }))
      .rejects.toThrow(/session\/usage limit/i)
  })

  it('matches the quota sentinel even when split across stream chunks', async () => {
    const child = makeFakeChild()
    // Emit the phrase in two pieces so the tail-carry boundary is exercised.
    mockSpawn.mockReturnValue(child)
    const dir = tmp()
    const p = runPortifyAgent({ agent: 'claude', prompt: 'go', cwd: dir })
    child.stdout.emit('data', Buffer.from('…some output, then you have '))
    child.stdout.emit('data', Buffer.from('hit your session limit now'))
    child.emit('close', 0)
    await expect(p).rejects.toThrow(/session\/usage limit/i)
  })
})

describe('isAgentSessionLimited', () => {
  it.each([
    "You've hit your session limit · resets 6:30pm",
    'Claude usage limit reached. Your limit will reset at 9am.',
    'you have hit your usage limit',
  ])('detects quota phrasing: %s', (s) => {
    expect(isAgentSessionLimited(s)).toBe(true)
  })

  it.each([
    'editing apps/gateway/src/main.ts to read injected port',
    'no port slots declared',
    '',
  ])('does not false-positive on normal output: %s', (s) => {
    expect(isAgentSessionLimited(s)).toBe(false)
  })
})
