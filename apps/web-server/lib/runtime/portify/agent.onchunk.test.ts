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
import { runPortifyAgent } from './agent'

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
})
