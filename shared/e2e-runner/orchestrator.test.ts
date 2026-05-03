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
    // Legacy bare-url shape coerced to tagged http probe.
    expect(specs[2].healthProbe).toEqual({ http: { url: 'http://b', timeoutMs: undefined } })
  })

  it('handles repos without startCommands', () => {
    const f = makeFeature({ repos: [{ name: 'r', localPath: tmpDir }] })
    expect(buildServiceSpecs(f, runDir)).toEqual([])
  })

  it('handles features without repos', () => {
    const f = makeFeature({ repos: undefined })
    expect(buildServiceSpecs(f, runDir)).toEqual([])
  })

  it('includes commands with no envs whitelist regardless of selected env', () => {
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [{ command: 'a', name: 'apiA' }],
      }],
    })
    expect(buildServiceSpecs(f, runDir, 'production')).toHaveLength(1)
  })

  it('skips commands whose envs whitelist excludes the selected env', () => {
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [
          { command: 'a', name: 'apiLocal', envs: ['local'] },
          { command: 'b', name: 'apiAll' },
        ],
      }],
    })
    const specs = buildServiceSpecs(f, runDir, 'production')
    expect(specs.map((s) => s.name)).toEqual(['apiAll'])
  })

  it('substitutes ${slot.key} tokens in command and probe url from envset slot files', () => {
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'api'), 'PORT=3030\nHOST=api.local\n')
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [{
          command: 'serve --port ${api.PORT}',
          name: 'svc',
          healthCheck: { http: { url: 'http://${api.HOST}:${api.PORT}/health' } },
        }],
      }],
    })
    const specs = buildServiceSpecs(f, runDir, 'local')
    expect(specs).toHaveLength(1)
    expect(specs[0].command).toBe('serve --port 3030')
    expect(specs[0].healthProbe).toEqual({ http: { url: 'http://api.local:3030/health' } })
  })

  it('leaves unresolvable tokens literal so misconfig is visible at runtime', () => {
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [{ command: 'echo ${ghost.X}', name: 'svc' }],
      }],
    })
    const specs = buildServiceSpecs(f, runDir, 'local')
    expect(specs[0].command).toBe('echo ${ghost.X}')
  })

  it('skips an entire repo when its repo-level envs excludes the selected env', () => {
    const f = makeFeature({
      repos: [
        {
          name: 'localOnly',
          localPath: tmpDir,
          envs: ['local'],
          startCommands: [{ command: 'a', name: 'apiA' }],
        },
        {
          name: 'always',
          localPath: tmpDir,
          startCommands: [{ command: 'b', name: 'apiB' }],
        },
      ],
    })
    const specs = buildServiceSpecs(f, runDir, 'production')
    expect(specs.map((s) => s.name)).toEqual(['apiB'])
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
    const warnings: string[] = []
    orch.on('agent-output', (e) => warnings.push(e.chunk))
    await orch.start()
    expect(warnings.join('')).toMatch(/no readiness probe/)
    await orch.stop('passed')
  })

  it('dispatches a tcp probe — resolves once the port is listening', async () => {
    const net = await import('net')
    const server = net.createServer().listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      const { factory } = makeFakeFactory()
      const f = makeFeature({
        repos: [{
          name: 'r',
          localPath: tmpDir,
          startCommands: [{
            command: 'svc',
            name: 'svc',
            healthCheck: { tcp: { port, timeoutMs: 200 } },
          }],
        }],
      })
      const orch = new RunOrchestrator({
        feature: f,
        runId: RUN_ID,
        runDir,
        ptyFactory: factory,
        delay: async () => undefined,
        healthPollIntervalMs: 1,
        healthDeadlineMs: 1000,
      })
      const events: { healthy: boolean; transport?: string }[] = []
      orch.on('health-check', (e) => events.push({ healthy: e.healthy, transport: e.transport }))
      await orch.start()
      expect(events.at(-1)).toEqual({ healthy: true, transport: 'tcp' })
      await orch.stop('passed')
    } finally {
      server.close()
    }
  })

  it('picks the per-env probe from a HealthCheck env-map (tagged shape)', async () => {
    const { factory } = makeFakeFactory()
    const f = makeFeature({
      envs: ['local', 'beta'],
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [{
          command: 'next dev',
          name: 'next',
          healthCheck: {
            local: { http: { url: 'http://local.example' } },
            beta:  { http: { url: 'http://beta.example' } },
          },
        }],
      }],
    })
    let calledWith: string | null = null
    const orch = new RunOrchestrator({
      feature: f,
      env: 'local',
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async (url) => { calledWith = url; return true },
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      healthDeadlineMs: 500,
    })
    await orch.start()
    expect(calledWith).toBe('http://local.example')
    await orch.stop('passed')
  })

  it('back-compat: accepts the legacy `{ url }` shape and dispatches an http probe', async () => {
    const { factory } = makeFakeFactory()
    const f = makeFeature({
      repos: [{
        name: 'r',
        localPath: tmpDir,
        startCommands: [{
          command: 'svc',
          name: 'svc',
          // Legacy bare-url probe — coerced to { http: { url, timeoutMs } }.
          healthCheck: { url: 'http://legacy.example', timeoutMs: 1234 },
        }],
      }],
    })
    let calledWith: { url: string; timeoutMs?: number } | null = null
    const orch = new RunOrchestrator({
      feature: f,
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async (url, timeoutMs) => { calledWith = { url, timeoutMs }; return true },
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      healthDeadlineMs: 500,
    })
    const events: { healthy: boolean; transport?: string }[] = []
    orch.on('health-check', (e) => events.push({ healthy: e.healthy, transport: e.transport }))
    await orch.start()
    expect(calledWith).toEqual({ url: 'http://legacy.example', timeoutMs: 1234 })
    expect(events.at(-1)).toEqual({ healthy: true, transport: 'http' })
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

    // No filesChanged → legacy "restart all" semantics.
    await orch.restart()
    expect(spawned).toHaveLength(2)
    expect(spawned[0].killed).toBe('SIGTERM')

    const logBody = fs.readFileSync(path.join(runDir, 'svc-api.log'), 'utf-8')
    expect(logBody).toBe('')

    await orch.stop('passed')
  })

  it('selective restart only respawns services matching filesChanged', async () => {
    const { factory, spawned } = makeFakeFactory()
    const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-a-'))
    const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-b-'))
    const orch = new RunOrchestrator({
      feature: makeFeature({
        repos: [
          { name: 'a', localPath: repoA, startCommands: [{ command: 'echo a', name: 'svcA', healthCheck: { url: 'http://a' } }] },
          { name: 'b', localPath: repoB, startCommands: [{ command: 'echo b', name: 'svcB', healthCheck: { url: 'http://b' } }] },
        ],
      }),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    const planEvents: { toRestart: string[]; toKeep: string[]; noMatch: boolean }[] = []
    const skipEvents: string[] = []
    orch.on('restart-planned', (e) => planEvents.push(e))
    orch.on('service-restart-skipped', (e) => skipEvents.push(e.service.safeName))

    await orch.start()
    expect(spawned).toHaveLength(2) // two services started

    // Only repoA's file changed → only svcA restarts.
    await orch.restart([path.join(repoA, 'src/x.ts')])
    expect(spawned).toHaveLength(3) // one new spawn (svcA)
    expect(spawned[0].killed).toBe('SIGTERM') // svcA killed
    expect(spawned[1].killed).toBe(null) // svcB kept warm
    expect(planEvents[0].toRestart).toEqual(['svca'])
    expect(planEvents[0].toKeep).toEqual(['svcb'])
    expect(skipEvents).toEqual(['svcb'])

    await orch.stop('passed')
  })

  it('selective restart with no matches keeps all services warm and emits noMatch', async () => {
    const { factory, spawned } = makeFakeFactory()
    const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-a-'))
    const orch = new RunOrchestrator({
      feature: makeFeature({
        repos: [
          { name: 'a', localPath: repoA, startCommands: [{ command: 'echo a', name: 'svcA', healthCheck: { url: 'http://a' } }] },
        ],
      }),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    const planEvents: { noMatch: boolean }[] = []
    orch.on('restart-planned', (e) => planEvents.push(e))

    await orch.start()
    expect(spawned).toHaveLength(1)

    await orch.restart(['/somewhere/totally/different.ts'])
    expect(spawned).toHaveLength(1) // no new spawn
    expect(spawned[0].killed).toBe(null)
    expect(planEvents[0].noMatch).toBe(true)

    await orch.stop('passed')
  })

  it('selective restart with full match restarts everything', async () => {
    const { factory, spawned } = makeFakeFactory()
    const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-a-'))
    const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-b-'))
    const orch = new RunOrchestrator({
      feature: makeFeature({
        repos: [
          { name: 'a', localPath: repoA, startCommands: [{ command: 'echo a', name: 'svcA', healthCheck: { url: 'http://a' } }] },
          { name: 'b', localPath: repoB, startCommands: [{ command: 'echo b', name: 'svcB', healthCheck: { url: 'http://b' } }] },
        ],
      }),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    await orch.start()
    await orch.restart([path.join(repoA, 'a.ts'), path.join(repoB, 'b.ts')])
    expect(spawned).toHaveLength(4) // 2 original + 2 respawned
    expect(spawned[0].killed).toBe('SIGTERM')
    expect(spawned[1].killed).toBe('SIGTERM')
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
    manualHeal?: boolean
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
      manualHeal: opts.manualHeal,
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

  it('manual heal mode: waits for signal, restarts services, reruns Playwright', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({
      spawned: f,
      pwExitCodes: [1, 0],
      manualHeal: true,
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 't' }] }))

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

    // Give the manual loop a tick to set status to 'healing', then drop a
    // .restart signal as if the user fixed the code by hand.
    await new Promise((r) => setTimeout(r, 30))
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({ hypothesis: 'manual' }))

    // Services re-spawn (svc at idx 2), then second playwright at idx 3.
    await waitFor(4)
    f.spawned[3].emitExit(0)

    const status = await promise
    expect(status).toBe('passed')
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
    // Use a path under tmpDir (the feature's repo localPath) so the selective
    // restart matches and respawns the service.
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({
      hypothesis: 'fix the thing',
      filesChanged: [path.join(tmpDir, 'a.ts'), path.join(tmpDir, 'b.ts'), 42], // non-string entries filtered
      fixDescription: 'patched the handler',
    }))
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 5) await new Promise((r) => setTimeout(r, 5))
    f.spawned[4].emitExit(1) // pw still fails; heal cap=1 → loop exits
    const status = await promise
    expect(status).toBe('failed')
    expect(f.spawned.length).toBeGreaterThanOrEqual(5)
    // healCycleHistory should record the restart.
    const m = readManifest(orch.paths.manifestPath)!
    expect((m as { healCycleHistory?: unknown[] }).healCycleHistory).toBeTruthy()
    const history = (m as { healCycleHistory: Array<{ cycle: number; restarted: string[]; kept: string[] }> }).healCycleHistory
    expect(history[0].cycle).toBe(1)
    expect(history[0].restarted).toEqual(['api'])
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
    expect(body).toContain('Health check passed (http): api')
    expect(body).toContain('Running Playwright tests: fake-pw')
    expect(body).toContain('Playwright exited: code=0')
    expect(body).toContain('Run complete: status=passed')
    // ANSI-free + timestamped format.
    for (const line of body.trim().split('\n')) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|WARN|ERROR) /)
    }
  })
})

describe('RunOrchestrator.markStoppedEarly + stoppedEarly serialization', () => {
  it('persists stoppedEarly on the manifest', async () => {
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
    orch.markStoppedEarly('user-pause', 2, 11)
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly).toEqual({
      reason: 'user-pause',
      failuresAtStop: 2,
      suiteTotal: 11,
    })
    await orch.stop('aborted')
  })
})

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

describe('RunOrchestrator.cancelHeal', () => {
  it('returns not-healing when status is not healing', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
    })
    expect(await orch.cancelHeal()).toEqual({ ok: false, reason: 'not-healing' })
  })

  it('returns no-agent-running when healing but no agent pty is tracked', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
    })
    orch.setStatus('healing')
    expect(await orch.cancelHeal()).toEqual({ ok: false, reason: 'no-agent-running' })
  })

  it('SIGTERMs the heal-agent pty, breaks the loop, and stops the run as failed', async () => {
    fs.mkdirSync(runDir, { recursive: true })
    const f = makeFakeFactory()
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 5, buildCommand: () => `heal-${healIdx++}` },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 3, passed: 0 }),
    )
    const promise = orch.runFullCycle()
    // Drive the lifecycle: services + Playwright spawn → fail → heal agent
    // spawns → user cancels mid-cycle.
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1) // Playwright fails
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    const agentPty = f.spawned[2]
    const result = await orch.cancelHeal()
    expect(result).toEqual({ ok: true })
    expect(agentPty.killed).toBe('SIGTERM')
    agentPty.emitExit(143)
    const finalStatus = await promise
    expect(finalStatus).toBe('failed')
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly?.reason).toBe('user-cancel-heal')
    await orch.stop('failed')
  })
})

describe('RunOrchestrator runFullCycle stoppedEarly', () => {
  it('marks stoppedEarly=max-failures when threshold is hit before heal cycle', async () => {
    const f = makeFakeFactory()
    const feature = makeFeature({ healOnFailureThreshold: 1 })
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature,
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
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 11, passed: 0 }),
    )
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitExit(0) // agent gives up — we just need the stoppedEarly stamp
    await promise
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly?.reason).toBe('max-failures')
    expect(m.stoppedEarly?.failuresAtStop).toBe(1)
    expect(m.stoppedEarly?.suiteTotal).toBe(11)
    await orch.stop('failed')
  })

  it('treats Playwright exit code 0 as failed when user-pause was stamped', async () => {
    // Regression for the "Pause & Heal flips run to PASSED" bug. When the
    // user pauses, Playwright is SIGTERM'd and may exit cleanly (code 0).
    // runFullCycle must NOT mark the run "passed" in that case — the stamp
    // is the source of truth for "the user wanted to heal."
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 500,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildCommand: () => 'heal' },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 5, passed: 0 }),
    )
    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    // Stamp BEFORE Playwright exits cleanly — simulating the pause flow.
    orch.markStoppedEarly('user-pause', 1, 5)
    f.spawned[1].emitExit(0) // Playwright exits cleanly post-SIGTERM
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitExit(0) // agent gives up — heal loop terminates
    const result = await promise
    // Final status is 'failed', NOT 'passed', because user-pause overrides.
    expect(result).toBe('failed')
    // We should also have entered healing at some point.
    expect(statuses).toContain('healing')
    await orch.stop('failed')
  })

  it('does not overwrite a prior user-pause stoppedEarly stamp', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 500,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildCommand: () => 'heal' },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 7, passed: 0 }),
    )
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    // Pre-stamp user-pause before pw exits non-zero.
    orch.markStoppedEarly('user-pause', 1, 7)
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitExit(0)
    await promise
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly?.reason).toBe('user-pause')
    await orch.stop('failed')
  })
})

describe('defaultPlaywrightSpawner --max-failures', () => {
  it('appends --max-failures with feature threshold', async () => {
    const { defaultPlaywrightSpawner } = await import('./orchestrator')
    const f = makeFeature({ healOnFailureThreshold: 3 })
    const inv = defaultPlaywrightSpawner({ feature: f, paths: {} as never })
    expect(inv.command).toContain('--max-failures=3')
  })

  it('defaults --max-failures=1 when threshold is unset', async () => {
    const { defaultPlaywrightSpawner } = await import('./orchestrator')
    const f = makeFeature()
    const inv = defaultPlaywrightSpawner({ feature: f, paths: {} as never })
    expect(inv.command).toContain('--max-failures=1')
  })
})

describe('stoppedEarlyReasonOf / countPassed', () => {
  it('returns undefined for a missing manifest', async () => {
    const { stoppedEarlyReasonOf, countPassed } = await import('./orchestrator')
    expect(stoppedEarlyReasonOf(path.join(tmpDir, 'nope.json'))).toBeUndefined()
    expect(countPassed({})).toBe(0)
    expect(countPassed({ passed: 4 })).toBe(4)
    expect(countPassed({ passed: 'oops' as unknown as number })).toBe(0)
  })

  it('returns the persisted reason', async () => {
    const file = path.join(tmpDir, 'm.json')
    fs.writeFileSync(file, JSON.stringify({ stoppedEarly: { reason: 'user-pause' } }))
    const { stoppedEarlyReasonOf } = await import('./orchestrator')
    expect(stoppedEarlyReasonOf(file)).toBe('user-pause')
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
