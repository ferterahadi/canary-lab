import { EventEmitter } from 'events'
import { vi } from 'vitest'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from '../../apps/web-server/src/features/runs/logic/runtime/pty-spawner'

/** One process the fake factory spawned: what it was asked to run, what the
 *  code under test wrote to it, and the two hooks a test uses to play the
 *  process's side (output, then exit). */
export interface FakePtyProcess {
  pid: number
  options: PtySpawnOptions
  data: EventEmitter
  exit: EventEmitter
  /** The signal of the last `kill`, `'SIGTERM'` when none was named; null
   *  until killed. Recorded only — the process does not exit until the test
   *  calls `emitExit`, so a test controls whether a kill is honoured. */
  killed: string | null
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  emitData(chunk: string): void
  emitExit(code: number, signal?: number): void
}

/** A `PtyFactory` that spawns nothing, so a test drives every service,
 *  Playwright and agent process the orchestrator starts. Pids count up from 100
 *  per factory, and each `onData`/`onExit` disposer really unsubscribes — the
 *  orchestrator relies on that to stop listening to a process it has replaced. */
export function makeFakePtyFactory(): { factory: PtyFactory; spawned: FakePtyProcess[] } {
  const spawned: FakePtyProcess[] = []
  let nextPid = 100
  const factory: PtyFactory = (options): PtyHandle => {
    const data = new EventEmitter()
    const exit = new EventEmitter()
    const proc: FakePtyProcess = {
      pid: nextPid++,
      options,
      data,
      exit,
      killed: null,
      writes: [],
      resizes: [],
      emitData(chunk) { data.emit('data', chunk) },
      emitExit(code, signal) { exit.emit('exit', { exitCode: code, signal }) },
    }
    spawned.push(proc)
    return {
      get pid() { return proc.pid },
      onData: (cb) => {
        data.on('data', cb)
        return { dispose: () => data.off('data', cb) }
      },
      onExit: (cb) => {
        exit.on('exit', cb)
        return { dispose: () => exit.off('exit', cb) }
      },
      write: vi.fn((data: string) => { proc.writes.push(data) }),
      resize: vi.fn((cols: number, rows: number) => {
        proc.resizes.push({ cols, rows })
      }),
      kill: (signal) => { proc.killed = signal ?? 'SIGTERM' },
    }
  }
  return { factory, spawned }
}
