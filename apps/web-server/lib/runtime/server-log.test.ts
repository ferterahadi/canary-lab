import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  DEFAULT_SERVER_LOG_RETENTION,
  installServerLogging,
  pruneServerLogs,
  resolveServerLogRetention,
  serverLogDir,
  serverLogFilename,
} from './server-log'

const tmpDirs: string[] = []
function mkLogsDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-server-log-')))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

// Minimal stream/process fakes so tests never tee the real process streams or
// register real crash handlers.
function fakeStream() {
  const chunks: string[] = []
  return { chunks, write: (c: string) => { chunks.push(c); return true } }
}
function fakeProc(pid = 4242) {
  const handlers = new Map<string, ((...a: unknown[]) => void)[]>()
  return {
    pid,
    exitCalls: [] as number[],
    on(event: string, cb: (...a: unknown[]) => void) {
      const list = handlers.get(event) ?? []
      list.push(cb)
      handlers.set(event, list)
      return this
    },
    off(event: string, cb: (...a: unknown[]) => void) {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== cb))
      return this
    },
    exit(code: number) { this.exitCalls.push(code) },
    emit(event: string, ...args: unknown[]) {
      for (const h of handlers.get(event) ?? []) h(...args)
    },
  }
}

const fixedNow = () => new Date('2026-06-08T14:30:05.123Z')

describe('serverLogFilename', () => {
  it('is filesystem-safe and lexicographically sortable', () => {
    expect(serverLogFilename(new Date('2026-06-08T14:30:05.123Z')))
      .toBe('canary-ui-2026-06-08T14-30-05-123Z.log')
  })

  it('sorts chronologically by name', () => {
    const earlier = serverLogFilename(new Date('2026-06-08T09:00:00.000Z'))
    const later = serverLogFilename(new Date('2026-06-08T18:00:00.000Z'))
    expect([later, earlier].sort()).toEqual([earlier, later])
  })
})

describe('resolveServerLogRetention', () => {
  it('defaults when unset', () => {
    expect(resolveServerLogRetention({})).toBe(DEFAULT_SERVER_LOG_RETENTION)
  })
  it('honours a valid override', () => {
    expect(resolveServerLogRetention({ CANARY_LAB_SERVER_LOG_RETENTION: '3' })).toBe(3)
  })
  it('falls back on garbage or non-positive values', () => {
    expect(resolveServerLogRetention({ CANARY_LAB_SERVER_LOG_RETENTION: 'nope' })).toBe(DEFAULT_SERVER_LOG_RETENTION)
    expect(resolveServerLogRetention({ CANARY_LAB_SERVER_LOG_RETENTION: '0' })).toBe(DEFAULT_SERVER_LOG_RETENTION)
  })
})

describe('pruneServerLogs', () => {
  it('keeps the newest N and removes older logs', () => {
    const logsDir = mkLogsDir()
    const dir = serverLogDir(logsDir)
    fs.mkdirSync(dir, { recursive: true })
    const names = [
      'canary-ui-2026-06-01T00-00-00-000Z.log',
      'canary-ui-2026-06-02T00-00-00-000Z.log',
      'canary-ui-2026-06-03T00-00-00-000Z.log',
      'canary-ui-2026-06-04T00-00-00-000Z.log',
    ]
    for (const n of names) fs.writeFileSync(path.join(dir, n), 'x')

    const result = pruneServerLogs(logsDir, 2)

    expect(result.removed).toEqual(names.slice(0, 2))
    expect(result.kept).toEqual(names.slice(2))
    expect(fs.readdirSync(dir).sort()).toEqual(names.slice(2))
  })

  it('ignores non-matching files and missing dirs', () => {
    const logsDir = mkLogsDir()
    const dir = serverLogDir(logsDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.txt'), 'keep me')
    fs.writeFileSync(path.join(dir, 'canary-ui-2026-06-01T00-00-00-000Z.log'), 'x')

    expect(pruneServerLogs(logsDir, 0)).toEqual({ kept: [], removed: [] })
    const result = pruneServerLogs(logsDir, 10)
    expect(result.removed).toEqual([])
    expect(fs.existsSync(path.join(dir, 'README.txt'))).toBe(true)

    expect(pruneServerLogs(mkLogsDir(), 5)).toEqual({ kept: [], removed: [] })
  })
})

describe('installServerLogging', () => {
  it('creates a timestamped log file and tees stdout/stderr while passing through', () => {
    const logsDir = mkLogsDir()
    const stdout = fakeStream()
    const stderr = fakeStream()
    const proc = fakeProc()

    const handle = installServerLogging(logsDir, { now: fixedNow, stdout, stderr, proc })

    expect(handle.logPath).toBe(
      path.join(serverLogDir(logsDir), 'canary-ui-2026-06-08T14-30-05-123Z.log'),
    )

    expect(stdout.write('hello stdout\n')).toBe(true)
    expect(stderr.write('oops stderr\n')).toBe(true)

    // Pass-through preserved.
    expect(stdout.chunks).toContain('hello stdout\n')
    expect(stderr.chunks).toContain('oops stderr\n')

    const contents = fs.readFileSync(handle.logPath, 'utf8')
    expect(contents).toContain('=== canary-lab ui — 2026-06-08T14:30:05.123Z — pid 4242 ===')
    expect(contents).toContain('hello stdout')
    expect(contents).toContain('oops stderr')

    handle.dispose()
  })

  it('records uncaught exceptions without forcing exit, and exits on unhandled rejection', () => {
    const logsDir = mkLogsDir()
    const proc = fakeProc()
    const handle = installServerLogging(logsDir, {
      now: fixedNow,
      stdout: fakeStream(),
      stderr: fakeStream(),
      proc,
    })

    proc.emit('uncaughtExceptionMonitor', new Error('boom'))
    proc.emit('unhandledRejection', 'rejected!')

    const contents = fs.readFileSync(handle.logPath, 'utf8')
    expect(contents).toContain('uncaughtException')
    expect(contents).toContain('boom')
    expect(contents).toContain('unhandledRejection')
    expect(contents).toContain('rejected!')
    // uncaughtExceptionMonitor must NOT exit (Node's default handles that);
    // unhandledRejection must exit(1) to preserve Node's default termination.
    expect(proc.exitCalls).toEqual([1])

    handle.dispose()
  })

  it('restores original writes and detaches handlers on dispose', () => {
    const logsDir = mkLogsDir()
    const stdout = fakeStream()
    const original = stdout.write
    const proc = fakeProc()

    const handle = installServerLogging(logsDir, {
      now: fixedNow,
      stdout,
      stderr: fakeStream(),
      proc,
    })
    expect(stdout.write).not.toBe(original)

    handle.dispose()
    expect(stdout.write).toBe(original)

    // Handlers detached: a post-dispose rejection no longer exits.
    proc.emit('unhandledRejection', 'late')
    expect(proc.exitCalls).toEqual([])
    // Idempotent.
    expect(() => handle.dispose()).not.toThrow()
  })

  it('tees non-string (Buffer) chunks and ignores null chunks', () => {
    const logsDir = mkLogsDir()
    const stdout = fakeStream()
    const handle = installServerLogging(logsDir, { now: fixedNow, stdout, stderr: fakeStream(), proc: fakeProc() })

    expect(stdout.write(Buffer.from('buffer-chunk\n'))).toBe(true)
    expect(stdout.write(null as unknown as string)).toBe(true) // null → no fs.writeSync, still passes through

    expect(fs.readFileSync(handle.logPath, 'utf8')).toContain('buffer-chunk')
    handle.dispose()
  })

  it('formats non-string rejection values as JSON, falling back to String on circular refs', () => {
    const logsDir = mkLogsDir()
    const proc = fakeProc()
    const handle = installServerLogging(logsDir, { now: fixedNow, stdout: fakeStream(), stderr: fakeStream(), proc })

    proc.emit('unhandledRejection', { code: 'E_PLAIN', detail: 'object' }) // JSON.stringify arm
    const circular: Record<string, unknown> = {}
    circular.self = circular
    proc.emit('unhandledRejection', circular) // JSON.stringify throws → String(value) fallback

    // An Error with no stack → the `name: message` fallback of formatError.
    const stackless = new Error('no-stack-here')
    stackless.stack = undefined
    proc.emit('uncaughtExceptionMonitor', stackless)

    const contents = fs.readFileSync(handle.logPath, 'utf8')
    expect(contents).toContain('E_PLAIN')
    expect(contents).toContain('[object Object]')
    expect(contents).toContain('Error: no-stack-here')
    handle.dispose()
  })

  it('prunes older logs on install, keeping the new file', () => {
    const logsDir = mkLogsDir()
    const dir = serverLogDir(logsDir)
    fs.mkdirSync(dir, { recursive: true })
    for (const n of [
      'canary-ui-2026-06-01T00-00-00-000Z.log',
      'canary-ui-2026-06-02T00-00-00-000Z.log',
    ]) fs.writeFileSync(path.join(dir, n), 'x')

    const handle = installServerLogging(logsDir, {
      now: fixedNow,
      retention: 1,
      stdout: fakeStream(),
      stderr: fakeStream(),
      proc: fakeProc(),
    })

    // Only the just-created log survives.
    expect(fs.readdirSync(dir)).toEqual([path.basename(handle.logPath)])
    handle.dispose()
  })
})
