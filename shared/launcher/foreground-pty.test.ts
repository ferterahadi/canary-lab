import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import {
  ForegroundLauncher,
  prefixLines,
} from './foreground-pty'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from '../e2e-runner/pty-spawner'

interface FakeProc {
  pid: number
  options: PtySpawnOptions
  data: EventEmitter
  exit: EventEmitter
  killed: string | null
  emitData(s: string): void
  emitExit(): void
}

function makeFactory(): { factory: PtyFactory; spawned: FakeProc[] } {
  const spawned: FakeProc[] = []
  let pid = 1
  const factory: PtyFactory = (options): PtyHandle => {
    const data = new EventEmitter()
    const exit = new EventEmitter()
    const proc: FakeProc = {
      pid: pid++,
      options,
      data,
      exit,
      killed: null,
      emitData: (s) => data.emit('data', s),
      emitExit: () => exit.emit('exit', { exitCode: 0 }),
    }
    spawned.push(proc)
    return {
      get pid() { return proc.pid },
      onData: (cb) => { data.on('data', cb); return { dispose: () => data.off('data', cb) } },
      onExit: (cb) => { exit.on('exit', cb); return { dispose: () => exit.off('exit', cb) } },
      write: vi.fn(),
      resize: vi.fn(),
      kill: (signal) => { proc.killed = signal ?? 'SIGTERM' },
    }
  }
  return { factory, spawned }
}

class MemStream extends EventEmitter implements NodeJS.WritableStream {
  data = ''
  writable = true
  write(chunk: string | Uint8Array): boolean {
    this.data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
    return true
  }
  end(): this { return this }
}

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-fg-')))
})

describe('prefixLines', () => {
  it('prefixes every line with [name]', () => {
    expect(prefixLines('api', 'a\nb\n')).toBe('[api] a\n[api] b\n')
  })

  it('prefixes a trailing partial line', () => {
    expect(prefixLines('api', 'no newline')).toBe('[api] no newline')
  })

  it('handles CRLF', () => {
    expect(prefixLines('x', 'a\r\nb')).toBe('[x] a\r\n[x] b')
  })

  it('passes empty input through', () => {
    expect(prefixLines('x', '')).toBe('')
  })
})

describe('ForegroundLauncher constructor defaults', () => {
  it('falls back to realPtyFactory + process.stdout when no opts are given', () => {
    // We can't actually spawn without a real PTY native; we just confirm the
    // constructor accepts defaults without throwing.
    const launcher = new ForegroundLauncher()
    expect(launcher).toBeInstanceOf(ForegroundLauncher)
    expect(launcher.getHandle('nope')).toBeUndefined()
  })
})

describe('ForegroundLauncher', () => {
  it('spawns a pty, mirrors output to `out`, and tees to log file', () => {
    const { factory, spawned } = makeFactory()
    const out = new MemStream()
    const launcher = new ForegroundLauncher({ ptyFactory: factory, out })
    const logPath = path.join(tmpDir, 'svc.log')

    const handle = launcher.open({ name: 'api', command: 'true', cwd: tmpDir, logPath })
    expect(handle.pid).toBe(spawned[0].pid)

    spawned[0].emitData('hello\n')

    expect(out.data).toBe('[api] hello\n')
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('hello\n')
    handle.stop()
    expect(spawned[0].killed).toBe('SIGTERM')
  })

  it('disables prefix when requested', () => {
    const { factory, spawned } = makeFactory()
    const out = new MemStream()
    const launcher = new ForegroundLauncher({ ptyFactory: factory, out, prefix: false })
    launcher.open({ name: 'api', command: 'true', cwd: tmpDir })
    spawned[0].emitData('hello')
    expect(out.data).toBe('hello')
  })

  it('replaces an existing tab when reopening with the same name', () => {
    const { factory, spawned } = makeFactory()
    const launcher = new ForegroundLauncher({ ptyFactory: factory, out: new MemStream() })
    launcher.open({ name: 'api', command: 'a', cwd: tmpDir })
    launcher.open({ name: 'api', command: 'b', cwd: tmpDir })
    expect(spawned).toHaveLength(2)
    expect(spawned[0].killed).toBe('SIGTERM')
  })

  it('closeAll stops everything', () => {
    const { factory, spawned } = makeFactory()
    const launcher = new ForegroundLauncher({ ptyFactory: factory, out: new MemStream() })
    launcher.open({ name: 'a', command: 'x', cwd: tmpDir })
    launcher.open({ name: 'b', command: 'x', cwd: tmpDir })
    launcher.closeAll()
    expect(spawned[0].killed).toBe('SIGTERM')
    expect(spawned[1].killed).toBe('SIGTERM')
    expect(launcher.getHandle('a')).toBeUndefined()
  })

  it('closeByName removes a single tab', () => {
    const { factory, spawned } = makeFactory()
    const launcher = new ForegroundLauncher({ ptyFactory: factory, out: new MemStream() })
    launcher.open({ name: 'a', command: 'x', cwd: tmpDir })
    launcher.open({ name: 'b', command: 'x', cwd: tmpDir })
    launcher.closeByName('a')
    expect(spawned[0].killed).toBe('SIGTERM')
    expect(spawned[1].killed).toBeNull()
    expect(launcher.getHandle('b')).toBeDefined()
    launcher.closeAll()
  })

  it('runs without a log file when none is given', () => {
    const { factory, spawned } = makeFactory()
    const out = new MemStream()
    const launcher = new ForegroundLauncher({ ptyFactory: factory, out })
    launcher.open({ name: 'a', command: 'x', cwd: tmpDir })
    spawned[0].emitData('hello\n')
    expect(out.data).toBe('[a] hello\n')
    launcher.closeAll()
  })

  it('cleans up the log stream on pty exit', () => {
    const { factory, spawned } = makeFactory()
    const launcher = new ForegroundLauncher({ ptyFactory: factory, out: new MemStream() })
    const logPath = path.join(tmpDir, 'a.log')
    launcher.open({ name: 'a', command: 'x', cwd: tmpDir, logPath })
    spawned[0].emitData('one')
    spawned[0].emitExit()
    // Subsequent writes after exit should be a no-op (stream ended).
    spawned[0].emitData('two')
    const body = fs.readFileSync(logPath, 'utf-8')
    expect(body.startsWith('one')).toBe(true)
    launcher.closeAll()
  })
})
