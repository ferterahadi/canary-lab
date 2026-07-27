import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor } from './run-paths'
import { readManifest, readRunsIndex, type RunLifecycleEvent } from './manifest'

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

describe('RunOrchestrator.runFullCycle', () => {
  function bootForFullCycle(opts: {
    spawned: { factory: PtyFactory; spawned: ReturnType<typeof makeFakeFactory>['spawned'] }
    pwExitCodes: number[]
    autoHeal?: boolean
    manualHeal?: boolean
    externalHeal?: boolean
  }) {
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: opts.spawned.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: ({ rerunTargets }) => ({
        command: `pw-${pwIdx++}${rerunTargets?.length ? ` ${rerunTargets.join(' ')}` : ''}`,
        cwd: tmpDir,
      }),
      autoHeal: opts.autoHeal
        ? {
            agent: 'claude',
            maxCycles: 2,
            buildSpawnCommand: () => `heal-${healIdx++}`,
          }
        : undefined,
      manualHeal: opts.manualHeal,
      externalHeal: opts.externalHeal,
    })
    return orch
  }

  function readLifecycleEvents(orch: RunOrchestrator): RunLifecycleEvent[] {
    return fs.readFileSync(orch.paths.lifecycleEventsPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunLifecycleEvent)
  }

  it('abort during auto-heal-eligible run does NOT spawn a heal agent', async () => {
    // Regression: with autoHeal configured, after stop() killed the
    // Playwright pty, runFullCycle would fall through into the heal loop
    // and spawn a fresh heal agent — the user had no way to stop it
    // because the manifest already said 'aborted' and the UI's Stop
    // button was gone. Guards inside runFullCycle now bail out as soon as
    // `this.stopped` is true.
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1], autoHeal: true })
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    // f.spawned: [0]=service, [1]=playwright. Abort while pw is running.
    await orch.stop('aborted')
    // Killed pw resolves with a "fail" exit code that, pre-fix, would
    // satisfy the auto-heal entry condition.
    f.spawned[1].emitExit(1)
    await promise
    // Only the service + playwright ptys should have been spawned. A heal
    // agent pty would be index [2] — its absence is the regression check.
    expect(f.spawned).toHaveLength(2)
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('aborted')
  })

  it('abort mid-run keeps manifest=aborted regardless of the pty exit code', async () => {
    // Regression: clicking Abort while runPlaywright is in flight used to
    // race the playwright pty's exit code. The exit-code branch in
    // runFullCycle would call setStatus('passed' | 'failed') AFTER stop()
    // had already written 'aborted', overwriting the terminal status. The
    // setStatus guard (`if (this.stopped) return`) makes that branch a
    // no-op so the persisted manifest stays 'aborted'.
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [0] })
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    // User clicks Abort while Playwright is still in flight.
    await orch.stop('aborted')
    // Playwright pty resolves with a "success" exit code after the abort.
    f.spawned[1].emitExit(0)
    await promise
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('aborted')
    expect(readRunsIndex(path.join(tmpDir, 'logs'))[0].status).toBe('aborted')
  })

  it('abort during service startup does not launch Playwright afterward', async () => {
    const f = makeFakeFactory()
    let resolveHealth!: (ok: boolean) => void
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => new Promise<boolean>((resolve) => { resolveHealth = resolve }),
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      playwrightSpawner: () => ({ command: 'pw-after-abort', cwd: tmpDir }),
    })

    const promise = orch.runFullCycle()
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))

    await orch.stop('aborted')
    resolveHealth(true)
    const status = await promise

    expect(status).toBe('aborted')
    expect(f.spawned).toHaveLength(1)
    expect(f.spawned[0].killed).toBe('SIGTERM')
    const manifest = readManifest(orch.paths.manifestPath)!
    expect(manifest.status).toBe('aborted')
    expect(manifest.services[0].status).toBe('stopped')
    expect(readRunsIndex(path.join(tmpDir, 'logs'))[0].status).toBe('aborted')
  })

  it('abort during service restart does not launch the post-restart Playwright rerun', async () => {
    const f = makeFakeFactory()
    let healthChecks = 0
    let resolveRestartHealth!: (ok: boolean) => void
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => {
        healthChecks += 1
        if (healthChecks === 1) return true
        return new Promise<boolean>((resolve) => { resolveRestartHealth = resolve })
      },
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => 'heal' },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'test-case-broken' }] }))

    const promise = orch.runFullCycle()
    while (f.spawned.length < 2) await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({ hypothesis: 'restart service' }))
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))

    await orch.stop('aborted')
    resolveRestartHealth(true)
    const status = await promise

    expect(status).toBe('aborted')
    expect(f.spawned).toHaveLength(4)
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('aborted')
    expect(readRunsIndex(path.join(tmpDir, 'logs'))[0].status).toBe('aborted')
  }, 15000)

  it('skips heal loop when autoHeal disabled and tests fail', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1] })
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    const status = await promise
    expect(status).toBe('failed')
    await orch.stop('failed')
  })

  it('manual heal mode: waits for signal, restarts services, reruns Playwright', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({
      spawned: f,
      pwExitCodes: [1, 0],
      manualHeal: true,
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 't', location: 'tests/demo.spec.ts:41' }] }))
    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))

    const promise = orch.runFullCycle()
    const waitFor = async (n: number) => {
      const start = Date.now()
      while (f.spawned.length < n) {
        if (Date.now() - start > 3000) throw new Error(`stuck: spawned=${f.spawned.length}`)
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    await waitFor(2)
    f.spawned[1].emitExit(1) // first playwright fails — orchestrator enters manual heal

    // Wait for the manual loop to enter the signal-waiting phase, then drop a
    // .restart signal as if the user fixed the code by hand.
    while (readManifest(orch.paths.manifestPath)?.lifecycle?.phase !== 'waiting-for-signal') {
      await new Promise((r) => setTimeout(r, 5))
    }
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({ hypothesis: 'manual' }))

    // Services re-spawn (svc at idx 2), then second playwright at idx 3.
    await waitFor(4)
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('running')
    expect(statuses).toContain('healing')
    expect(statuses.at(-1)).toBe('running')
    expect(f.spawned[3].options.command).toContain('tests/demo.spec.ts:41')
    // Mimic the SummaryReporter: a successful rerun replaces the seeded
    // failed entry with a passed entry. Without this, decideRunStatus would
    // still see `failed: [...]` in the file and correctly mark the run failed.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passedNames: ['t'],
      failed: [],
    }))
    f.spawned[3].emitExit(0)

    const status = await promise
    expect(status).toBe('passed')
    await orch.stop('passed')
  }, 15000)

  it('external heal mode writes the canonical journal from the signal only', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, 'handler.ts'), '// initial\n')
    execFileSync('git', ['add', 'handler.ts'], { cwd: tmpDir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir })

    const f = makeFakeFactory()
    const orch = bootForFullCycle({
      spawned: f,
      pwExitCodes: [1, 0],
      externalHeal: true,
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      failed: [{ name: 'test-case-checkout', location: 'tests/checkout.spec.ts:41' }],
    }))

    const promise = orch.runFullCycle()
    const waitFor = async (n: number) => {
      const start = Date.now()
      while (f.spawned.length < n) {
        if (Date.now() - start > 3000) throw new Error(`stuck: spawned=${f.spawned.length}`)
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    await waitFor(2)
    f.spawned[1].emitExit(1)

    while (readManifest(orch.paths.manifestPath)?.lifecycle?.phase !== 'waiting-for-signal') {
      await new Promise((r) => setTimeout(r, 5))
    }
    fs.writeFileSync(path.join(tmpDir, 'handler.ts'), '// external client edit\n')
    fs.writeFileSync(orch.paths.rerunSignal, JSON.stringify({
      hypothesis: 'handler returns stale checkout state',
      fixDescription: 'updated handler response state',
    }))

    await waitFor(3)
    expect(f.spawned[2].options.command).toContain('tests/checkout.spec.ts:41')
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passedNames: ['test-case-checkout'],
      failed: [],
    }))
    f.spawned[2].emitExit(0)

    const status = await promise
    expect(status).toBe('passed')
    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    expect(journal).toContain('- run: 2026-04-28T1015-aaaa')
    expect(journal).toContain('- feature: demo')
    expect(journal).toContain('- failingTests: test-case-checkout')
    expect(journal).toContain('- hypothesis: handler returns stale checkout state')
    expect(journal).toContain(`- fix.file: ${path.join(tmpDir, 'handler.ts')}`)
    expect(journal).toContain('- fix.description: updated handler response state')
    expect(journal).toContain('- signal: .rerun')
    expect(journal).toContain('- outcome: pending')
    expect(journal).toContain('### Diff')
    expect(journal).toContain('+// external client edit')
    await orch.stop('passed')
  }, 15000)

  it('manual heal mode: gives up if user cancels via cancelHeal()', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({
      spawned: f,
      pwExitCodes: [1],
      manualHeal: true,
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 't' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    // Wait for the orchestrator to enter the manual heal loop, then mimic
    // a user-cancel by writing the same flag the manual loop watches.
    await new Promise((r) => setTimeout(r, 30))
    // Manual mode has no agent pty so cancelHeal returns no-agent-running.
    // Instead, stop() races the loop's signal-wait and resolves it as
    // 'aborted'.
    await orch.stop('aborted')
    const status = await promise
    expect(['failed', 'aborted']).toContain(status)
  }, 15000)

  it('writes signalPaths and healMode to the manifest in manual mode', () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [0], manualHeal: true })
    // Trigger initial manifest write by booting a run.
    return (async () => {
      const promise = orch.runFullCycle()
      await new Promise((r) => setTimeout(r, 5))
      f.spawned[1].emitExit(0)
      await promise
      const m = JSON.parse(fs.readFileSync(orch.paths.manifestPath, 'utf-8'))
      expect(m.healMode).toBe('manual')
      expect(m.signalPaths.rerun).toBe(orch.paths.rerunSignal)
      expect(m.signalPaths.restart).toBe(orch.paths.restartSignal)
      await orch.stop('passed')
    })()
  })

  it('writes the resolved auto-heal agent to the manifest', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [0], autoHeal: true })

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(0)
    await promise

    const m = JSON.parse(fs.readFileSync(orch.paths.manifestPath, 'utf-8'))
    expect(m.healMode).toBe('auto')
    expect(m.healAgent).toBe('claude')
    await orch.stop('passed')
  })

  it('runs heal cycle on failure and recovers via .restart signal', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1, 0], autoHeal: true })
    // Seed e2e-summary.json so failedSlugs is non-empty.
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'test-case-broken', endTime: 100, location: 'e2e/broken.spec.ts:12' }] }),
    )

    const heal: { cycle: number; failureSignature: string }[] = []
    const statuses: string[] = []
    orch.on('heal-cycle-started', (e) => heal.push(e))
    orch.on('run-status', (e) => statuses.push(e.status))

    const promise = orch.runFullCycle()
    const waitFor = async (n: number, label: string) => {
      const start = Date.now()
      while (f.spawned.length < n) {
        if (Date.now() - start > 3000) {
          throw new Error(`stuck waiting for ${label}: spawned=${f.spawned.length}`)
        }
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    await waitFor(2, 'first playwright')
    f.spawned[1].emitExit(1) // pw fails

    await waitFor(3, 'heal agent')
    // Drop a .restart signal mid-agent so waitForHealSignal sees it after exit.
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({ hypothesis: 'stub' }))
    f.spawned[2].emitExit(0) // agent exits

    // After restart-and-rerun: services re-spawn (svc spawn at idx 3) + new playwright (idx 4).
    await waitFor(5, 'second playwright')
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('running')
    expect(statuses).toEqual(expect.arrayContaining(['failed', 'healing', 'running']))
    expect(statuses.at(-1)).toBe('running')
    expect(f.spawned[4].options.command).toContain('e2e/broken.spec.ts:12')
    // Mimic the SummaryReporter: rerun cleared the failed entry. Without
    // this, decideRunStatus would (correctly) treat the seeded failed entry
    // as still-failing and mark the run failed.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passedNames: ['test-case-broken'],
      failed: [],
    }))
    f.spawned[4].emitExit(0) // pw passes

    const status = await promise
    expect(status).toBe('passed')
    expect(heal[0].cycle).toBe(1)
    expect(heal[0].failureSignature).toBe('test-case-broken')
    await orch.stop('passed')
  }, 15000)
})
