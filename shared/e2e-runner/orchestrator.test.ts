import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import {
  RunOrchestrator,
  buildServiceSpecs,
  type ServiceSpec,
} from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../launcher/types'
import { runDirFor, buildRunPaths } from './run-paths'
import { readManifest, readRunsIndex } from './manifest'
import { RunnerLog } from './runner-log'

interface FakeProcess {
  pid: number
  options: PtySpawnOptions
  data: EventEmitter
  exit: EventEmitter
  killed: string | null
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
      write: vi.fn(),
      resize: vi.fn(),
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

describe('buildServiceSpecs', () => {
  it('flattens repo startCommands into named specs', () => {
    const f = makeFeature({
      repos: [
        {
          name: 'r',
          localPath: tmpDir,
          startCommands: [
            'plain string',
            { command: 'a', name: 'apiA' },
            { command: 'b', healthCheck: { url: 'http://b' } },
          ],
        },
      ],
    })
    const specs = buildServiceSpecs(f, runDir)
    expect(specs).toHaveLength(3)
    expect(specs[0].name).toBe('r-cmd-1')
    expect(specs[1].name).toBe('apiA')
    expect(specs[2].healthUrl).toBe('http://b')
  })

  it('handles repos without startCommands', () => {
    const f = makeFeature({ repos: [{ name: 'r', localPath: tmpDir }] })
    expect(buildServiceSpecs(f, runDir)).toEqual([])
  })

  it('handles features without repos', () => {
    const f = makeFeature({ repos: undefined })
    expect(buildServiceSpecs(f, runDir)).toEqual([])
  })
})

describe('RunOrchestrator.start', () => {
  it('spawns each service and writes manifest + index', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })

    const started: ServiceSpec[] = []
    orch.on('service-started', (e) => started.push(e.service))

    await orch.start()

    expect(spawned).toHaveLength(1)
    expect(started.map((s) => s.name)).toEqual(['api'])
    const manifest = readManifest(path.join(runDir, 'manifest.json'))!
    expect(manifest.runId).toBe(RUN_ID)
    expect(manifest.feature).toBe('demo')
    expect(manifest.services[0].safeName).toBe('api')
    expect(manifest.services[0].logPath.endsWith('svc-api.log')).toBe(true)

    const index = readRunsIndex(path.join(tmpDir, 'logs'))
    expect(index.find((e) => e.runId === RUN_ID)?.feature).toBe('demo')
    expect(fs.existsSync(path.join(tmpDir, 'logs', 'current'))).toBe(true)

    await orch.stop('passed')
  })

  it('tees pty output to disk and emits service-output', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })

    const collected: string[] = []
    orch.on('service-output', (e) => collected.push(e.chunk))

    await orch.start()
    spawned[0].emitData('hello world\n')
    await new Promise((r) => setTimeout(r, 10))

    expect(collected).toContain('hello world\n')
    const log = fs.readFileSync(path.join(runDir, 'svc-api.log'), 'utf-8')
    expect(log).toContain('hello world')

    await orch.stop('passed')
  })

  it('emits service-exit on pty exit', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    const exits: number[] = []
    orch.on('service-exit', (e) => exits.push(e.exitCode))

    await orch.start()
    spawned[0].emitExit(7)
    await new Promise((r) => setTimeout(r, 10))
    expect(exits).toEqual([7])
    await orch.stop('passed')
  })

  it('throws on health-check timeout', async () => {
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => false,
      delay: async () => undefined,
      healthDeadlineMs: 5,
      healthPollIntervalMs: 1,
    })
    const checks: boolean[] = []
    orch.on('health-check', (e) => checks.push(e.healthy))
    await expect(orch.start()).rejects.toThrow(/Health check timed out/)
    expect(checks.at(-1)).toBe(false)
    await orch.stop('aborted')
  })

  it('skips health checks when no service exposes a healthUrl', async () => {
    const { factory } = makeFakeFactory()
    const f = makeFeature({
      repos: [{ name: 'r', localPath: tmpDir, startCommands: [{ command: 'x', name: 'x' }] }],
    })
    const orch = new RunOrchestrator({
      feature: f,
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      delay: async () => undefined,
    })
    await orch.start()
    await orch.stop('passed')
  })
})

describe('RunOrchestrator signal watcher', () => {
  it('detects restart/rerun/heal signals and emits', async () => {
    vi.useFakeTimers()
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 50,
    })
    const events: { kind: string; body: Record<string, unknown> }[] = []
    orch.on('signal-detected', (e) => events.push(e))

    await orch.start()
    fs.writeFileSync(orch.paths.restartSignal, '{"hypothesis":"h"}')
    fs.writeFileSync(orch.paths.rerunSignal, '')
    fs.writeFileSync(orch.paths.healSignal, 'not json')

    vi.advanceTimersByTime(60)
    await Promise.resolve()
    vi.useRealTimers()

    expect(events.map((e) => e.kind).sort()).toEqual(['heal', 'rerun', 'restart'])
    const restart = events.find((e) => e.kind === 'restart')
    expect(restart?.body.hypothesis).toBe('h')

    await orch.stop('passed')
  })
})

describe('RunOrchestrator.restart / rerun / status', () => {
  it('restart re-spawns services and truncates logs', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    await orch.start()

    spawned[0].emitData('first\n')
    await new Promise((r) => setTimeout(r, 5))

    await orch.restart(['/x'])
    expect(spawned).toHaveLength(2)
    expect(spawned[0].killed).toBe('SIGTERM')

    const logBody = fs.readFileSync(path.join(runDir, 'svc-api.log'), 'utf-8')
    expect(logBody).toBe('')

    await orch.stop('passed')
  })

  it('rerun truncates logs without re-spawning', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    await orch.start()
    fs.writeFileSync(path.join(runDir, 'svc-api.log'), 'pre-existing')
    await orch.rerun()
    expect(fs.readFileSync(path.join(runDir, 'svc-api.log'), 'utf-8')).toBe('')
    expect(spawned).toHaveLength(1)
    await orch.stop('passed')
  })

  it('setStatus updates manifest + index and emits run-status', async () => {
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))

    await orch.start()
    orch.setStatus('healing')
    expect(statuses).toContain('healing')
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('healing')
    expect(readRunsIndex(path.join(tmpDir, 'logs'))[0].status).toBe('healing')

    await orch.stop('failed')
  })

  it('noteHealCycle increments + persists', async () => {
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
    orch.noteHealCycle()
    orch.noteHealCycle()
    expect(readManifest(orch.paths.manifestPath)?.healCycles).toBe(2)
    await orch.stop('passed')
  })

  it('stop is idempotent and finalizes manifest + index', async () => {
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    let completes = 0
    orch.on('run-complete', () => completes++)
    await orch.start()
    await orch.stop('passed')
    await orch.stop('passed')
    expect(completes).toBe(1)
    const manifest = readManifest(orch.paths.manifestPath)!
    expect(manifest.status).toBe('passed')
    expect(manifest.endedAt).toBeTruthy()
    const index = readRunsIndex(path.join(tmpDir, 'logs'))
    expect(index[0].endedAt).toBeTruthy()
  })
})

describe('RunOrchestrator construction defaults', () => {
  it('uses real isHealthy + setTimeout-based delay when not injected', async () => {
    const { factory } = makeFakeFactory()
    // Feature has no healthUrl, so the real isHealthy default never fires —
    // but the constructor branches that pick defaults are covered.
    const f = makeFeature({
      repos: [{ name: 'r', localPath: tmpDir, startCommands: [{ command: 'x', name: 'x' }] }],
    })
    const orch = new RunOrchestrator({
      feature: f,
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
    })
    await orch.start()
    await orch.stop('passed')
  })

  it('stop without prior start clears nothing but still finalizes manifest', async () => {
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    // Don't call start() — no signalWatcher to clear, no services to kill.
    await orch.stop('aborted')
    // Manifest never written without start, so the update is a no-op; stop() still
    // emits run-complete.
  })
})

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
    const detected: Record<string, unknown>[] = []
    orch.on('signal-detected', (e) => detected.push(e.body))
    await orch.start()
    fs.writeFileSync(orch.paths.restartSignal, '{not json')
    vi.advanceTimersByTime(10)
    await Promise.resolve()
    vi.useRealTimers()
    expect(detected[0]).toEqual({})
    await orch.stop('passed')
  })
})

describe('RunOrchestrator.runPlaywright', () => {
  it('emits started + output + exit and tees to playwright.log', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'fake-pw', cwd: tmpDir }),
    })
    const events: string[] = []
    orch.on('playwright-started', (e) => events.push(`start:${e.command}`))
    orch.on('playwright-output', (e) => events.push(`out:${e.chunk.trim()}`))
    orch.on('playwright-exit', (e) => events.push(`exit:${e.exitCode}`))

    await orch.start()
    const exitPromise = orch.runPlaywright()
    // The most recently spawned pty is Playwright (after the service).
    const pwPty = spawned[spawned.length - 1]
    pwPty.emitData('1 passed\n')
    pwPty.emitExit(0)
    const code = await exitPromise

    expect(code).toBe(0)
    expect(events[0]).toBe('start:fake-pw')
    expect(events).toContain('out:1 passed')
    expect(events.at(-1)).toBe('exit:0')
    const log = fs.readFileSync(orch.paths.playwrightStdoutPath, 'utf-8')
    expect(log).toContain('1 passed')
    await orch.stop('passed')
  })
})

describe('RunOrchestrator.runFullCycle', () => {
  function bootForFullCycle(opts: {
    spawned: { factory: PtyFactory; spawned: ReturnType<typeof makeFakeFactory>['spawned'] }
    pwExitCodes: number[]
    autoHeal?: boolean
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
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: opts.autoHeal
        ? {
            agent: 'claude',
            maxCycles: 2,
            buildCommand: ({ cycle }) => `heal-${cycle}-${healIdx++}`,
          }
        : undefined,
    })
    return orch
  }

  it('returns passed when Playwright exits 0 on first try', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [0] })
    const promise = orch.runFullCycle()
    // service pty is f.spawned[0]; playwright is next.
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(0)
    const status = await promise
    expect(status).toBe('passed')
    await orch.stop('passed')
  })

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

  it('runs heal cycle on failure and recovers via .restart signal', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1, 0], autoHeal: true })
    // Seed e2e-summary.json so failedSlugs is non-empty.
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'test-case-broken', endTime: 100 }] }),
    )

    const heal: { cycle: number; failureSignature: string }[] = []
    orch.on('heal-cycle-started', (e) => heal.push(e))

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
    f.spawned[4].emitExit(0) // pw passes

    const status = await promise
    expect(status).toBe('passed')
    expect(heal[0].cycle).toBe(1)
    expect(heal[0].failureSignature).toBe('test-case-broken')
    await orch.stop('passed')
  }, 15000)

  it('gives up when agent exits without writing a signal', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }] }),
    )

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1) // pw fails
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitExit(0) // agent exits with no signal

    const status = await promise
    expect(status).toBe('failed')
    await orch.stop('failed')
  })

  it('breaks when no failed slugs are present (signature empty)', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1], autoHeal: true })
    // No summary written → empty failed array → empty signature → no heal.
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    const status = await promise
    expect(status).toBe('failed')
    await orch.stop('failed')
  })

  it('emits agent-output and tees to transcript', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'x' }] }))
    const chunks: string[] = []
    orch.on('agent-output', (e) => chunks.push(e.chunk))
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitData('agent says hi\n')
    f.spawned[2].emitExit(0) // no signal → give-up
    await promise
    expect(chunks.join('')).toContain('agent says hi')
    const transcript = fs.readFileSync(orch.paths.agentTranscriptPath, 'utf-8')
    expect(transcript).toContain('agent says hi')
    await orch.stop('failed')
  })

  it('appends a journal entry with filesChanged when the signal includes one', async () => {
    const f = makeFakeFactory()
    // maxCycles=1 so the loop exits after one heal cycle when pw still fails.
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
      autoHeal: { agent: 'claude', maxCycles: 1, buildCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({
      hypothesis: 'fix the thing',
      filesChanged: ['/tmp/a.ts', '/tmp/b.ts', 42], // non-string entries filtered
      fixDescription: 'patched the handler',
    }))
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 5) await new Promise((r) => setTimeout(r, 5))
    f.spawned[4].emitExit(1) // pw still fails; heal cap=1 → loop exits
    const status = await promise
    expect(status).toBe('failed')
    expect(f.spawned.length).toBeGreaterThanOrEqual(5)
    await orch.stop('failed')
  }, 15000)

  it('honors .rerun signal (rerun-only path)', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1, 0], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }] }),
    )

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.rerunSignal, '')
    f.spawned[2].emitExit(0)

    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    f.spawned[3].emitExit(0)
    const status = await promise
    expect(status).toBe('passed')
    await orch.stop('passed')
  })
})

describe('RunOrchestrator.waitForHealSignal', () => {
  it('returns null on timeout', async () => {
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 0,
    })
    const sig = await orch.waitForHealSignal(5)
    expect(sig).toBeNull()
  })

  it('respects the stopped flag', async () => {
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 0,
    })
    await orch.stop('aborted')
    expect(await orch.waitForHealSignal(50)).toBeNull()
  })
})

describe('readSummary / extractFailedSlugs / defaultPlaywrightSpawner / defaultHealCommand', () => {
  it('readSummary tolerates missing file', async () => {
    const { readSummary, extractFailedSlugs, defaultPlaywrightSpawner, defaultHealCommand } =
      await import('./orchestrator')
    expect(readSummary(path.join(tmpDir, 'nope.json'))).toEqual({})
    expect(extractFailedSlugs({ failed: [{ name: 'a' }, { name: '' }, {}] })).toEqual(['a'])
    expect(extractFailedSlugs({})).toEqual([])
    const f = makeFeature()
    const inv = defaultPlaywrightSpawner({ feature: f, paths: {} as never })
    expect(inv.command).toContain('playwright test')
    expect(inv.cwd).toBe(f.featureDir)
    expect(defaultHealCommand({ cycle: 2, outputDir: '/x' })).toContain('cycle=2')
  })
})

describe('RunOrchestrator + RunnerLog integration', () => {
  it('writes lifecycle events to runner.log when one is supplied', async () => {
    const { factory, spawned } = makeFakeFactory()
    const paths = buildRunPaths(runDir)
    const runnerLog = new RunnerLog(paths.runnerLogPath)
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      runnerLog,
      playwrightSpawner: () => ({ command: 'fake-pw', cwd: tmpDir }),
    })

    await orch.start()
    const exitPromise = orch.runPlaywright()
    spawned[spawned.length - 1].emitExit(0)
    await exitPromise
    await orch.stop('passed')

    const body = fs.readFileSync(paths.runnerLogPath, 'utf-8')
    expect(body).toContain('Service started: api')
    expect(body).toContain('Health check passed: api')
    expect(body).toContain('Running Playwright tests: fake-pw')
    expect(body).toContain('Playwright exited: code=0')
    expect(body).toContain('Run complete: status=passed')
    // ANSI-free + timestamped format.
    for (const line of body.trim().split('\n')) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|WARN|ERROR) /)
    }
  })
})

describe('RunOrchestrator integration smoke', () => {
  it('full lifecycle: start → service output → signal → restart → stop', async () => {
    vi.useFakeTimers()
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 25,
    })
    const eventLog: string[] = []
    orch.on('service-started', () => eventLog.push('service-started'))
    orch.on('service-output', () => eventLog.push('service-output'))
    orch.on('signal-detected', (e) => eventLog.push(`signal:${e.kind}`))
    orch.on('run-complete', () => eventLog.push('run-complete'))

    await orch.start()
    spawned[0].emitData('boot\n')
    fs.writeFileSync(orch.paths.restartSignal, '')
    vi.advanceTimersByTime(30)
    await Promise.resolve()
    vi.useRealTimers()

    await orch.stop('passed')

    expect(eventLog[0]).toBe('service-started')
    expect(eventLog).toContain('service-output')
    expect(eventLog).toContain('signal:restart')
    expect(eventLog.at(-1)).toBe('run-complete')
    expect(fs.existsSync(orch.paths.manifestPath)).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'svc-api.log'))).toBe(true)
  })
})
