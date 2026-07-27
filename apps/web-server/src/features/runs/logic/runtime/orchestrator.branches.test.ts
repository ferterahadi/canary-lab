import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator, type ServiceSpec } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor } from './run-paths'

interface FakeProcess {
  pid: number
  options: PtySpawnOptions
  data: EventEmitter
  exit: EventEmitter
  killed: string | null
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  emitData(chunk: string): void
  emitExit(code: number, signal?: number): void
}

function makeFakeFactory(): { factory: PtyFactory; spawned: FakeProcess[] } {
  const spawned: FakeProcess[] = []
  let nextPid = 100
  const factory: PtyFactory = (options): PtyHandle => {
    const data = new EventEmitter()
    const exit = new EventEmitter()
    const proc: FakeProcess = {
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

let tmpDir: string

let runDir: string

const RUN_ID = '2026-04-28T1015-aaaa'

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-')))
  runDir = runDirFor(path.join(tmpDir, 'logs'), RUN_ID)
  fs.mkdirSync(runDir, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
})

function makeFeature(over: Partial<FeatureConfig> = {}): FeatureConfig {
  return {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir: path.join(tmpDir, 'features', 'demo'),
    repos: [
      {
        name: 'api',
        localPath: tmpDir,
        startCommands: [{ command: 'echo hi', name: 'api', healthCheck: { url: 'http://x' } }],
      },
    ],
    ...over,
  }
}

describe('RunOrchestrator branch coverage', () => {
  it('start() is safely re-entrant and signalWatcher dedupes', async () => {
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    await orch.start()
    // Second start() re-enters startSignalWatcher's `if (this.signalWatcher) return`
    // branch and re-spawns services (idempotent for our fake factory).
    await orch.start()
    await orch.stop('passed')
  })

  it('respects stopped flag during health-check loop', async () => {
    const { factory } = makeFakeFactory()
    let probes = 0
    let resolved = false
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      // Each probe schedules a stop after the first call, then returns false
      // so the loop's `if (this.stopped) return` branch fires next iteration.
      healthCheck: async () => {
        probes++
        if (probes === 1) {
          // Defer stop until next microtask so the loop checks `stopped` next.
          queueMicrotask(() => {
            resolved = true
            void orch.stop('aborted')
          })
        }
        return false
      },
      delay: async () => undefined,
      healthDeadlineMs: 1_000,
      healthPollIntervalMs: 0,
    })
    await orch.start().catch(() => {})
    expect(resolved).toBe(true)
    expect(probes).toBeGreaterThan(0)
  })

  it('signal watcher tolerates malformed JSON bodies', async () => {
    vi.useFakeTimers()
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
    })
    const ignored: string[] = []
    orch.on('signal-ignored', (e) => ignored.push(e.reason))
    await orch.start()
    fs.writeFileSync(orch.paths.restartSignal, '{not json')
    vi.advanceTimersByTime(10)
    await Promise.resolve()
    vi.useRealTimers()
    expect(ignored).toEqual(['not-waiting-for-signal'])
    await orch.stop('passed')
  })

  it('throws on an unknown health-probe shape (exhaustiveness guard)', async () => {
    // The config loader/validator normally rejects a malformed healthCheck at
    // load time, so the only way to reach this guard is to force a probe
    // shape past the type system directly onto a built ServiceSpec.
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    ;(orch.services[0] as unknown as { healthProbe: unknown }).healthProbe = { weird: true }
    await expect(orch.start()).rejects.toThrow(/Unknown probe shape for api/)
    await orch.stop('aborted')
  })

  it('ensureLogFile skips remaking a log file it already tracks (crash-then-respawn)', async () => {
    // A service that crashes mid-run (pty exit without an explicit restart())
    // stays in `logFiles` — the next spawn for that same service hits the
    // early-return branch instead of re-touching the file.
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 2,
    })
    await orch.start()
    expect(spawned).toHaveLength(1)
    fs.writeFileSync(orch.paths.serviceLog('api'), 'stale output\n')
    // Crash it — pty exits without going through restart(), so `logFiles`
    // still has the path tracked.
    spawned[0].emitExit(1)
    // start() is re-entrant (see "start() is safely re-entrant" above) — the
    // public path back into ensureServicesRunning() for a crashed service.
    await orch.start()
    expect(spawned).toHaveLength(2)
    // The log was NOT truncated by ensureLogFile's early return — only a
    // real restart() truncates via its own writeFileSync.
    expect(fs.readFileSync(orch.paths.serviceLog('api'), 'utf-8')).toBe('stale output\n')
    await orch.stop('aborted')
  })
})
