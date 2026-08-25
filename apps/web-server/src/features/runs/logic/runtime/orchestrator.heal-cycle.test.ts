import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor } from './run-paths'
import { readManifest, type RunLifecycleEvent } from './manifest'

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

  it('continues into another heal cycle when Playwright exits 0 but summary still has failures', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1, 0], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'test-case-broken', location: 'e2e/broken.spec.ts:12' }] }),
    )
    const heal: number[] = []
    orch.on('heal-cycle-started', (event) => heal.push(event.cycle))

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
    f.spawned[1].emitExit(1)
    await waitFor(3, 'first heal agent')
    fs.writeFileSync(orch.paths.rerunSignal, JSON.stringify({ hypothesis: 'try again' }))
    f.spawned[2].emitExit(0)

    await waitFor(4, 'second playwright')
    // Leave the failed summary intact while Playwright exits cleanly. The
    // orchestrator must trust decideRunStatus over the process exit byte and
    // spawn heal cycle 2 instead of finalizing the run as failed.
    f.spawned[3].emitExit(0)
    await waitFor(5, 'second heal agent')

    expect(heal).toEqual([1, 2])
    await orch.stop('failed')
    await promise
  }, 15000)

  it('applies the latest pane size when the heal agent spawns after an early resize event', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a', location: 'e2e/a.spec.ts:9' }] }),
    )

    orch.resizeHealAgent(0, 24)
    orch.resizeHealAgent(160.8, 42.2)

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))

    expect(f.spawned[2].options.cols).toBe(160)
    expect(f.spawned[2].options.rows).toBe(42)

    f.spawned[2].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('resizes the active heal-agent pty and bounds the remembered dimensions', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a', location: 'e2e/a.spec.ts:9' }] }),
    )

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))

    const agent = f.spawned[2]
    orch.resizeHealAgent(Number.NaN, 24)
    orch.resizeHealAgent(80, Number.POSITIVE_INFINITY)
    orch.resizeHealAgent(0, 24)
    orch.resizeHealAgent(80, -1)
    expect(agent.resizes).toEqual([])

    orch.resizeHealAgent(100_000.9, 2_000.2)
    orch.resizeHealAgent(80.8, 24.2)
    expect(agent.resizes).toEqual([
      { cols: 1000, rows: 1000 },
      { cols: 80, rows: 24 },
    ])

    f.spawned[2].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('gives up but still writes a journal entry when the agent exits without a signal and made no code changes', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a', location: 'e2e/a.spec.ts:9' }] }),
    )
    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1) // pw fails
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitExit(0) // agent exits with no signal

    const status = await promise
    expect(status).toBe('failed')
    // Journal entry preserves the audit trail even when the agent forgot to signal.
    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    expect(journal).toContain('Heal agent exited without writing a signal.')
    expect(journal).toContain('No code changes detected.')
    expect(journal).toContain('- signal: none')
    // healEnd records WHY the loop stopped: no signal, pty died.
    const healEnd = readManifest(orch.paths.manifestPath)?.healEnd
    expect(healEnd).toMatchObject({ reason: 'no-signal', agentWait: 'pty-died', cycle: 1 })
    await orch.stop('failed')
  })

  it('ends the heal loop with an idle-timeout journal entry when the live agent stays silent', async () => {
    // Agent pty is alive throughout — never emits data, never exits. The
    // idle timeout (100ms here) should fire and end the loop with a
    // reason-specific journal entry, not the generic "exited" message.
    const f = makeFakeFactory()
    let pwIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 60_000, // hard ceiling well above the idle window
      healAgentIdleTimeoutMs: 100, // 100ms of silence → idle-timeout
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => 'heal' },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1) // pw fails → heal loop entered
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Do NOT emit any data or exit on the agent pty — let idle timeout fire.

    const status = await promise
    expect(status).toBe('failed')
    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    expect(journal).toContain('Heal agent went silent')
    expect(journal).not.toContain('exited without writing')
    expect(journal).toContain('- signal: none')
    // Silent agent that emitted nothing → no-signal / idle-timeout, no cause.
    const healEnd = readManifest(orch.paths.manifestPath)?.healEnd
    expect(healEnd).toMatchObject({ reason: 'no-signal', agentWait: 'idle-timeout', cycle: 1 })
    expect(healEnd?.agentCause).toBeUndefined()
    await orch.stop('failed')
    const events = readLifecycleEvents(orch)
    expect(events.slice(-2).map((event) => event.headline)).not.toEqual(['Run failed', 'Run failed'])
  }, 10000)
})
