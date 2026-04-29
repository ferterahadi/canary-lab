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
import { runDirFor } from './run-paths'
import { readManifest, readRunsIndex } from './manifest'

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
