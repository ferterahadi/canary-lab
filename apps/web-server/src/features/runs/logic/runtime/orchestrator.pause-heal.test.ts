import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor } from './run-paths'
import { readManifest } from './manifest'

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

describe('RunOrchestrator.pauseAndHeal', () => {
  function bootForPause(): {
    factory: PtyFactory
    spawned: ReturnType<typeof makeFakeFactory>['spawned']
    orch: RunOrchestrator
  } {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
    })
    return { factory, spawned, orch }
  }

  it('returns no-playwright-running when nothing is in flight', async () => {
    const { orch } = bootForPause()
    await orch.start()
    expect(await orch.pauseAndHeal()).toEqual({ ok: false, reason: 'no-playwright-running' })
    await orch.stop('passed')
  })

  it('returns already-healing when status is healing', async () => {
    const { orch } = bootForPause()
    await orch.start()
    orch.setStatus('healing')
    expect(await orch.pauseAndHeal()).toEqual({ ok: false, reason: 'already-healing' })
    await orch.stop('aborted')
  })

  it('returns no-failures-yet WITHOUT killing Playwright when summary is empty', async () => {
    // Regression: previous behaviour SIGTERM'd Playwright then bailed with
    // no-failures-yet, leaving the run to be marked "passed" by runFullCycle.
    // The new contract is check-then-commit — no kill until we have failures.
    const { spawned, orch } = bootForPause()
    await orch.start()
    const exitPromise = orch.runPlaywright()
    const pausePromise = orch.pauseAndHeal()
    await new Promise((r) => setTimeout(r, 5))
    const pwPty = spawned[spawned.length - 1]
    expect(pwPty.killed).toBeNull()
    expect(await pausePromise).toEqual({ ok: false, reason: 'no-failures-yet' })
    // Playwright is still alive — clean up by emitting its exit explicitly.
    pwPty.emitExit(0)
    await exitPromise
    await orch.stop('aborted')
  })

  it('SIGTERMs Playwright, marks stoppedEarly=user-pause, returns ok with failureCount', async () => {
    const { spawned, orch } = bootForPause()
    await orch.start()
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }, { name: 'b' }], total: 11, passed: 0 }),
    )
    const exitPromise = orch.runPlaywright()
    const pausePromise = orch.pauseAndHeal()
    await new Promise((r) => setTimeout(r, 5))
    const pwPty = spawned[spawned.length - 1]
    expect(pwPty.killed).toBe('SIGTERM')
    pwPty.emitExit(143)
    await exitPromise
    const result = await pausePromise
    expect(result).toEqual({ ok: true, failureCount: 2 })
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly).toEqual({
      reason: 'user-pause',
      failuresAtStop: 2,
      suiteTotal: 11,
    })
    expect(fs.readFileSync(orch.paths.lifecycleEventsPath, 'utf-8')).toContain('Pause accepted')
    await orch.stop('aborted')
  })

  it('falls back to SIGKILL when SIGTERM is ignored past the 5s deadline', async () => {
    vi.useFakeTimers()
    const { spawned, orch } = bootForPause()
    await orch.start()
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }] }),
    )
    void orch.runPlaywright()
    // Advance microtasks so spawn completes.
    await Promise.resolve()
    const pwPty = spawned[spawned.length - 1]
    const pausePromise = orch.pauseAndHeal()
    await Promise.resolve()
    expect(pwPty.killed).toBe('SIGTERM')
    // Push past the 5s graceful deadline without firing an exit.
    await vi.advanceTimersByTimeAsync(5001)
    expect(pwPty.killed).toBe('SIGKILL')
    // Push past the secondary 1s deadline so the fallback wait resolves.
    await vi.advanceTimersByTimeAsync(1001)
    const result = await pausePromise
    expect(result).toEqual({ ok: true, failureCount: 1 })
    vi.useRealTimers()
    pwPty.emitExit(137)
    await orch.stop('aborted')
  })

  it('pause-and-heal does not let runFullCycle mark the run "passed" when Playwright exits 0 on SIGTERM', async () => {
    // Regression: if Playwright catches SIGTERM and exits cleanly with code
    // 0, the naive `finalStatus = exitCode === 0 ? 'passed' : 'failed'`
    // would mark the whole run passed. The override at
    // runFullCycle:1184 keys off `stoppedEarlyReason === 'user-pause'` to
    // flip back to 'failed' so the heal loop is entered. Without that
    // override, the user's Pause & Heal click would silently auto-complete
    // the run as passed.
    const f = makeFakeFactory()
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    // Failing summary so pauseAndHeal commits (no-failures-yet would no-op).
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }))

    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    // spawned[0] = api service, spawned[1] = playwright.
    while (f.spawned.length < 2) await new Promise((r) => setTimeout(r, 5))
    const pwPty = f.spawned[1]
    expect(pwPty.killed).toBeNull()

    // Kick off pauseAndHeal but don't await it yet — it's blocked on
    // `waitForPlaywrightExit`. We need to emit pw exit while it's blocked,
    // otherwise the 5s SIGKILL fallback fires before the test can proceed.
    const pausePromise = orch.pauseAndHeal()
    await new Promise((r) => setTimeout(r, 5))
    expect(pwPty.killed).toBe('SIGTERM')
    // Critical step: pw exits CLEANLY (exit code 0). This is the case the
    // override exists to handle — without it, finalStatus would be 'passed'.
    pwPty.emitExit(0)
    expect(await pausePromise).toEqual({ ok: true, failureCount: 1 })

    // Wait for the heal loop to set status to 'healing' (spawned[2] = heal agent).
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))

    // At this point the run must NOT be 'passed'. The override should have
    // flipped finalStatus to 'failed' and the heal loop should have advanced
    // status to 'healing'.
    expect(statuses).toContain('healing')
    expect(statuses).not.toContain('passed')

    // The manifest reflects the override.
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly?.reason).toBe('user-pause')

    // Cleanup: agent exits without a signal → heal loop bails with 'failed'.
    f.spawned[2].emitExit(0)
    await promise
    await orch.stop('failed')
  }, 15000)

  it('does not mark a run "passed" when pw exits 0 but the summary still has failures (race fix)', async () => {
    // Regression: pty.onExit can fire BEFORE the user's pause-heal request
    // reaches the server, so `stoppedEarlyReason` is never set and the
    // user-pause override is bypassed. With pw exiting cleanly (code 0), the
    // run would silently finalize as 'passed' — even though the summary still
    // records the failures the user reacted to. The safety net at
    // runFullCycle flips back to 'failed' when summary disagrees with the
    // exit code, so the heal loop is entered as the user expected.
    const f = makeFakeFactory()
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    // Summary records a failure (the user saw it and clicked pause-heal).
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }))

    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    while (f.spawned.length < 2) await new Promise((r) => setTimeout(r, 5))
    // pw exits cleanly with code 0 BEFORE any pauseAndHeal arrives.
    // stoppedEarlyReason is undefined — the override would let 'passed' slip
    // through. The safety net should catch the summary's failure entry and
    // flip the run back to 'failed', entering the heal loop.
    f.spawned[1].emitExit(0)
    // spawned[2] = heal agent (only spawned if the heal loop entered).
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))

    expect(statuses).toContain('healing')
    expect(statuses).not.toContain('passed')

    // Cleanup: agent exits without a signal so the loop bails 'failed'.
    f.spawned[2].emitExit(0)
    await promise
    await orch.stop('failed')
  }, 15000)

  it('emits paused-by-user with the failure count', async () => {
    const { spawned, orch } = bootForPause()
    await orch.start()
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'x' }], total: 3, passed: 0 }),
    )
    const events: number[] = []
    orch.on('paused-by-user', (e) => events.push(e.failureCount))
    const exitPromise = orch.runPlaywright()
    const pausePromise = orch.pauseAndHeal()
    await new Promise((r) => setTimeout(r, 5))
    const pwPty = spawned[spawned.length - 1]
    pwPty.emitExit(143)
    await exitPromise
    await pausePromise
    expect(events).toEqual([1])
    await orch.stop('aborted')
  })
})
