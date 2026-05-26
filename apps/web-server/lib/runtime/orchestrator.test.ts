import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import {
  RunOrchestrator,
  buildServiceSpecs,
  type ServiceSpec,
} from './orchestrator'
import * as sessionLog from '../agent-session-log'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../shared/launcher/types'
import { runDirFor, buildRunPaths } from './run-paths'
import { readManifest, readRunsIndex, type RunLifecycleEvent } from './manifest'
import { RunnerLog } from './runner-log'

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
    expect(specs[1]).toMatchObject({ repoName: 'r' })
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
  it('starts cleanly when a feature has no services', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ repos: [] }),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      delay: async () => undefined,
    })
    await orch.start()
    expect(spawned).toHaveLength(0)
    expect(readManifest(orch.paths.manifestPath)?.services).toEqual([])
    await orch.stop('passed')
  })

  it('spawns each service and writes manifest + index', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      repoBranchSnapshots: [{
        name: 'api',
        path: tmpDir,
        branch: 'main',
        expectedBranch: 'main',
        detached: false,
        dirty: false,
      }],
    })

    const started: ServiceSpec[] = []
    orch.on('service-started', (e) => started.push(e.service))

    await orch.start()

    expect(spawned).toHaveLength(1)
    expect(started.map((s) => s.name)).toEqual(['api'])
    const manifest = readManifest(path.join(runDir, 'manifest.json'))!
    expect(manifest.runId).toBe(RUN_ID)
    expect(manifest.feature).toBe('demo')
    expect(manifest.services[0]).toMatchObject({ repoName: 'api', name: 'api' })
    expect(manifest.services[0].safeName).toBe('api')
    expect(manifest.services[0].logPath.endsWith('svc-api.log')).toBe(true)
    expect(manifest.repoBranches).toEqual([{
      name: 'api',
      path: tmpDir,
      branch: 'main',
      expectedBranch: 'main',
      detached: false,
      dirty: false,
    }])
    expect(manifest.playwrightArtifacts).toEqual({
      screenshot: 'only-on-failure',
      video: 'off',
      trace: 'retain-on-failure',
    })

    const index = readRunsIndex(path.join(tmpDir, 'logs'))
    expect(index.find((e) => e.runId === RUN_ID)?.feature).toBe('demo')
    expect(fs.existsSync(path.join(tmpDir, 'logs', 'current'))).toBe(false)

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
    expect(readManifest(orch.paths.manifestPath)?.lifecycle).toMatchObject({
      phase: 'aborted',
      abortReason: { reason: 'service-health-failed', service: 'api' },
    })
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

  it('includes the selected env in missing-probe warnings', async () => {
    const { factory } = makeFakeFactory()
    const f = makeFeature({
      envs: ['beta'],
      repos: [{ name: 'r', localPath: tmpDir, startCommands: [{ command: 'x', name: 'x' }] }],
    })
    const orch = new RunOrchestrator({
      feature: f,
      env: 'beta',
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      delay: async () => undefined,
    })
    const warnings: string[] = []
    orch.on('agent-output', (e) => warnings.push(e.chunk))
    await orch.start()
    expect(warnings.join('')).toContain('for env "beta"')
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
  it('consumes and records signals as ignored when not waiting for heal input', async () => {
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
    const events: { kind: string; reason: string }[] = []
    orch.on('signal-ignored', (e) => events.push(e))

    await orch.start()
    fs.writeFileSync(orch.paths.restartSignal, '{"hypothesis":"h"}')
    fs.writeFileSync(orch.paths.rerunSignal, '')
    fs.writeFileSync(orch.paths.healSignal, 'not json')

    vi.advanceTimersByTime(60)
    await Promise.resolve()
    vi.useRealTimers()

    expect(events.map((e) => e.kind).sort()).toEqual(['heal', 'rerun', 'restart'])
    expect(events.every((e) => e.reason === 'not-waiting-for-signal')).toBe(true)
    expect(readManifest(orch.paths.manifestPath)?.lifecycle?.lastSignal).toMatchObject({
      status: 'ignored',
    })

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

  it('ignores a stale service exit from a pty replaced during restart', async () => {
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
    orch.on('service-exit', (event) => exits.push(event.exitCode))

    await orch.start()
    await orch.restart()
    expect(spawned).toHaveLength(2)

    spawned[0].emitExit(1)
    expect(exits).toEqual([])

    spawned[1].emitExit(2)
    expect(exits).toEqual([2])

    await orch.stop('failed')
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
    expect(pwPty.options.env).toMatchObject({
      CANARY_LAB_MANIFEST_PATH: orch.paths.manifestPath,
      CANARY_LAB_SUMMARY_PATH: orch.paths.summaryPath,
    })
    expect(pwPty.options.env.CANARY_LAB_TARGETED_RERUN).toBeUndefined()
    const log = fs.readFileSync(orch.paths.playwrightStdoutPath, 'utf-8')
    expect(log).toContain('1 passed')
    await orch.stop('passed')
  })

  it('marks targeted reruns so the summary reporter can merge previous statuses', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: ({ rerunTargets }) => ({
        command: `fake-pw ${rerunTargets?.join(' ') ?? ''}`.trim(),
        cwd: tmpDir,
      }),
    })

    await orch.start()
    const exitPromise = orch.runPlaywright(['e2e/a.spec.ts:10'])
    const pwPty = spawned[spawned.length - 1]
    pwPty.emitExit(0)
    await exitPromise

    expect(pwPty.options.env).toMatchObject({
      CANARY_LAB_TARGETED_RERUN: '1',
      CANARY_LAB_MANIFEST_PATH: orch.paths.manifestPath,
      CANARY_LAB_SUMMARY_PATH: orch.paths.summaryPath,
    })
    expect(readManifest(orch.paths.manifestPath)?.lifecycle?.targetedRerun).toMatchObject({
      selected: 1,
      mode: 'failed-and-pending',
    })
    await orch.stop('passed')
  })

  it('refreshes the stop-and-heal threshold from disk before each Playwright spawn', async () => {
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), [
      'exports.config = {',
      '  name: "demo",',
      '  description: "demo",',
      '  envs: ["local"],',
      '  featureDir: __dirname,',
      '  repos: [],',
      '  healOnFailureThreshold: 4,',
      '}',
      '',
    ].join('\n'))
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ featureDir, repos: [], healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })

    const firstRun = orch.runPlaywright()
    spawned.at(-1)!.emitExit(1)
    await firstRun
    expect(spawned.at(-1)!.options.command).toContain('--max-failures=4')

    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), [
      'exports.config = {',
      '  name: "demo",',
      '  description: "demo",',
      '  envs: ["local"],',
      '  featureDir: __dirname,',
      '  repos: [],',
      '}',
      '',
    ].join('\n'))

    const secondRun = orch.runPlaywright()
    spawned.at(-1)!.emitExit(1)
    await secondRun
    expect(spawned.at(-1)!.options.command).not.toContain('--max-failures=')
  })

  it('mirrors per-test artifact dirs into playwright-artifacts-keep on Playwright exit', async () => {
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

    await orch.start()
    const exitPromise = orch.runPlaywright()
    const pwPty = spawned[spawned.length - 1]
    // Simulate Playwright writing per-test artifacts into the live dir
    // before the process exits.
    const liveCase = path.join(orch.paths.playwrightArtifactsDir, 'pw-slug-a')
    fs.mkdirSync(liveCase, { recursive: true })
    fs.writeFileSync(path.join(liveCase, 'video.webm'), 'fresh-webm')
    fs.writeFileSync(path.join(liveCase, 'trace.zip'), 'fresh-trace')
    pwPty.emitExit(0)
    await exitPromise

    const keepCase = path.join(orch.paths.playwrightArtifactsKeepDir, 'pw-slug-a')
    expect(fs.readFileSync(path.join(keepCase, 'video.webm'), 'utf-8')).toBe('fresh-webm')
    expect(fs.readFileSync(path.join(keepCase, 'trace.zip'), 'utf-8')).toBe('fresh-trace')
    await orch.stop('passed')
  })

  it('overwrites the keep copy for the same pw-slug and preserves untouched tests', async () => {
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

    // Pre-seed the keep dir as if a prior cycle had run two tests: A and B.
    const keepA = path.join(orch.paths.playwrightArtifactsKeepDir, 'pw-a')
    const keepB = path.join(orch.paths.playwrightArtifactsKeepDir, 'pw-b')
    fs.mkdirSync(keepA, { recursive: true })
    fs.mkdirSync(keepB, { recursive: true })
    fs.writeFileSync(path.join(keepA, 'video.webm'), 'a-stale')
    fs.writeFileSync(path.join(keepB, 'video.webm'), 'b-stale')

    await orch.start()
    const exitPromise = orch.runPlaywright()
    const pwPty = spawned[spawned.length - 1]
    // The "rerun" only writes test A's pw-slug into the live dir.
    const liveA = path.join(orch.paths.playwrightArtifactsDir, 'pw-a')
    fs.mkdirSync(liveA, { recursive: true })
    fs.writeFileSync(path.join(liveA, 'video.webm'), 'a-fresh')
    pwPty.emitExit(0)
    await exitPromise

    // A is overwritten with the latest attempt's bytes.
    expect(fs.readFileSync(path.join(keepA, 'video.webm'), 'utf-8')).toBe('a-fresh')
    // B is untouched — it wasn't in this rerun's live dir.
    expect(fs.readFileSync(path.join(keepB, 'video.webm'), 'utf-8')).toBe('b-stale')
    await orch.stop('passed')
  })
})

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
            buildCommand: ({ cycle }) => `heal-${cycle}-${healIdx++}`,
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
      autoHeal: { agent: 'claude', maxCycles: 1, buildCommand: () => 'heal' },
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
      autoHeal: { agent: 'claude', maxCycles: 1, buildCommand: () => 'heal' },
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
    await orch.stop('failed')
    const events = readLifecycleEvents(orch)
    expect(events.slice(-2).map((event) => event.headline)).not.toEqual(['Run failed', 'Run failed'])
  }, 10000)

  it('ends the heal loop with a hard-timeout journal entry when the cycle hits the absolute ceiling', async () => {
    // Agent pty is alive AND producing output continuously (never goes
    // idle), but the hard ceiling kicks in. Should write a hard-timeout
    // journal entry — not idle, not exited.
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
      healAgentTimeoutMs: 200, // hard ceiling we'll deliberately hit
      healAgentIdleTimeoutMs: 60_000, // idle window much larger than ceiling
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildCommand: () => 'heal' },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Keep emitting data so the idle clock stays fresh until the hard
    // ceiling fires.
    const pump = setInterval(() => {
      if (f.spawned[2]) f.spawned[2].emitData('thinking...\n')
    }, 20)
    try {
      const status = await promise
      expect(status).toBe('failed')
      const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
      expect(journal).toContain('Heal cycle hit the')
      expect(journal).toContain('minute ceiling')
      expect(journal).toContain('- signal: none')
    } finally {
      clearInterval(pump)
      await orch.stop('failed')
    }
  }, 10000)

  it('writes agent-session.json pointing at the claude session JSONL after the heal flow ends', async () => {
    // Stand up a fake `~/.claude/projects/<encoded-runDir>/<uuid>.jsonl` so
    // the locator finds something at the predicted path. We point HOME at a
    // temp dir for the duration of the test so the orchestrator's
    // os.homedir() lookup resolves there.
    const originalHome = process.env.HOME
    const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-home-')))
    process.env.HOME = homeDir
    try {
      const f = makeFakeFactory()
      // Capture the orchestrator's view of the run dir (realpathSync'd
      // tmpDir) so the encoded project path matches.
      const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1], autoHeal: true })
      // The orchestrator generates a UUID for claude session id internally;
      // we can't predict it. Instead, create the fake JSONL eagerly after the
      // agent pty is spawned, when the orchestrator has written the id to
      // agentSessionIdPath.
      fs.mkdirSync(runDir, { recursive: true })
      fs.writeFileSync(
        orch.paths.summaryPath,
        JSON.stringify({ failed: [{ name: 'a' }] }),
      )

      const promise = orch.runFullCycle()
      await new Promise((r) => setTimeout(r, 10))
      f.spawned[1].emitExit(1) // pw fails → heal loop entered
      // Wait for the agent pty spawn AND for the session id sidecar.
      while (f.spawned.length < 3 || !fs.existsSync(orch.paths.agentSessionIdPath)) {
        await new Promise((r) => setTimeout(r, 5))
      }
      const sessionId = fs.readFileSync(orch.paths.agentSessionIdPath, 'utf-8').trim()
      expect(sessionId).toMatch(/^[0-9a-f-]+$/i)
      // Drop the fake JSONL where locateClaudeSessionLog looks. The encoder
      // just replaces `/` with `-`, so the leading slash already becomes the
      // leading dash — no extra prefix.
      const encoded = runDir.replace(/\//g, '-')
      const projectDir = path.join(homeDir, '.claude', 'projects', encoded)
      fs.mkdirSync(projectDir, { recursive: true })
      const logPath = path.join(projectDir, `${sessionId}.jsonl`)
      fs.writeFileSync(logPath, '')

      // End the heal cycle: agent exits without signal so the loop bails fast.
      f.spawned[2].emitExit(0)
      await promise
      await orch.stop('failed')

      const ref = JSON.parse(fs.readFileSync(orch.paths.agentSessionRefPath, 'utf-8'))
      expect(ref).toEqual({
        activeAgent: 'claude',
        sessions: {
          claude: { agent: 'claude', sessionId, logPath },
        },
      })
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      try { fs.rmSync(homeDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }, 15000)

  it('infers a rerun and writes a journal entry when the agent edits files but exits without a signal', async () => {
    // tmpDir is the feature's repo localPath — make it a git repo so the
    // orchestrator's snapshot/diff sees the agent's edits.
    execFileSync('git', ['init', '-q'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, 'svc.ts'), '// initial\n')
    execFileSync('git', ['add', 'svc.ts'], { cwd: tmpDir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir })

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
      autoHeal: { agent: 'claude', maxCycles: 1, buildCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1) // pw fails → enter heal loop
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Agent edits a tracked file then exits without writing a signal file.
    fs.writeFileSync(path.join(tmpDir, 'svc.ts'), '// patched by agent\n')
    f.spawned[2].emitExit(0)
    // Inferred .rerun: no service restart, just a second playwright run.
    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    f.spawned[3].emitExit(1) // still failing; cap=1 → loop exits

    const status = await promise
    expect(status).toBe('failed')

    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    expect(journal).toContain('Heal agent exited without writing a signal.')
    expect(journal).toContain('Runner inferred a rerun from git diff.')
    expect(journal).toContain(path.join(tmpDir, 'svc.ts'))
    // The 4th spawn (idx 3) is the inferred-rerun's playwright; without the
    // fallback the loop would have bailed before that pty existed.
    expect(f.spawned.length).toBeGreaterThanOrEqual(4)
    await orch.stop('failed')
  }, 15000)

  it('agent exit unwedges the loop within one poll tick (no waiting for the heal-agent timeout)', async () => {
    // Regression: when claude's REPL exits unexpectedly mid-cycle (user
    // typed `/exit`, crash, etc.), the orchestrator used to keep polling
    // for a `.heal`/`.rerun`/`.restart` signal until the full
    // `healAgentTimeoutMs` elapsed (10 min in production). Now
    // `waitForHealSignal` also exits when `healAgentPty` is null, so the
    // loop bails out via the "agent exited unexpectedly" branch.
    fs.mkdirSync(runDir, { recursive: true })
    const f = makeFakeFactory()
    let pwIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 5,
      // Long timeout — the test should resolve via the new pty-null exit,
      // NOT by waiting for this number to elapse.
      healAgentTimeoutMs: 60_000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: () => 'cat',
        buildCyclePrompt: () => 'cycle prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 3, passed: 0 }),
    )

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1) // pw fails
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))

    const start = Date.now()
    f.spawned[2].emitExit(0) // agent dies cleanly without any signal
    const status = await promise
    const elapsed = Date.now() - start

    expect(status).toBe('failed')
    // Without the fix, this would be ~60_000ms. With the fix, well under 1s.
    expect(elapsed).toBeLessThan(2000)
    await orch.stop('failed')
  }, 10000)

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

  it('emits agent-output chunks for the live broker', async () => {
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
    // The broker pushes these chunks to live xterm subscribers; historical
    // replay reads the agent CLI's own JSONL session log instead (no disk
    // transcript is written here).
    expect(chunks.join('')).toContain('agent says hi')
    await orch.stop('failed')
  })

  it('runner-observed git diff drives the journal fix.file and the restart plan', async () => {
    // tmpDir is the feature's repo localPath; turn it into a git repo with
    // a baseline commit so the runner's snapshot-then-diff path picks up
    // files the agent edits between snapshot and signal.
    execFileSync('git', ['init', '-q'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// initial a\n')
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// initial b\n')
    execFileSync('git', ['add', 'a.ts', 'b.ts'], { cwd: tmpDir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir })

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
    // Agent's turn: modify the tracked files (the snapshot was taken right
    // before the agent pty was spawned, so these edits are inside the
    // iteration's diff window).
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// edited a\n')
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// edited b\n')
    // New signal body shape: hypothesis + fixDescription only. The runner
    // detects files via git, not from this body.
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({
      hypothesis: 'fix the thing',
      fixDescription: 'patched the handler',
    }))
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 5) await new Promise((r) => setTimeout(r, 5))
    f.spawned[4].emitExit(1) // pw still fails; heal cap=1 → loop exits
    const status = await promise
    expect(status).toBe('failed')
    expect(f.spawned.length).toBeGreaterThanOrEqual(5)
    // healCycleHistory should record the restart, matched against the diff'd files.
    const m = readManifest(orch.paths.manifestPath)!
    expect((m as { healCycleHistory?: unknown[] }).healCycleHistory).toBeTruthy()
    const history = (m as { healCycleHistory: Array<{ cycle: number; restarted: string[]; kept: string[] }> }).healCycleHistory
    expect(history[0].cycle).toBe(1)
    expect(history[0].restarted).toEqual(['api'])
    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    expect(journal).toContain('- hypothesis: fix the thing')
    expect(journal).toContain('- fix.description: patched the handler')
    expect(journal).toContain(`- fix.file: ${path.join(tmpDir, 'a.ts')}, ${path.join(tmpDir, 'b.ts')}`)
    expect(fs.existsSync(path.join(tmpDir, 'logs', 'diagnosis-journal.md'))).toBe(false)
    await orch.stop('failed')
  }, 15000)

  it('isolates the agent edit window from pre-existing dirty state', async () => {
    // Workspace is dirty BEFORE heal runs (user WIP). The journal must record
    // only what the agent edited during its turn — pre-existing dirty files
    // must not leak in.
    execFileSync('git', ['init', '-q'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// initial a\n')
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// initial b\n')
    execFileSync('git', ['add', 'a.ts', 'b.ts'], { cwd: tmpDir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir })
    // Pre-existing WIP — dirty BEFORE the orchestrator starts. The agent
    // never touches this file; the diff must not include it.
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// pre-existing dirty\n')

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
      autoHeal: { agent: 'claude', maxCycles: 1, buildCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Agent edits only b.ts, leaves the pre-existing dirty a.ts alone.
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// edited b by agent\n')
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({
      hypothesis: 'fixed b',
      fixDescription: 'only touched b',
    }))
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 5) await new Promise((r) => setTimeout(r, 5))
    f.spawned[4].emitExit(1)
    await promise

    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    // fix.file records only the agent's edit, not the pre-existing dirty file.
    expect(journal).toContain(`- fix.file: ${path.join(tmpDir, 'b.ts')}`)
    expect(journal).not.toContain(`- fix.file: ${path.join(tmpDir, 'a.ts')}`)
    expect(journal).not.toMatch(new RegExp(`fix\\.file:.*${path.basename(tmpDir)}/a\\.ts`))
    await orch.stop('failed')
  }, 15000)

  it('aggregates fix.file across multiple feature repos when the agent edits in each', async () => {
    // Two git-tracked feature repos. Each gets its own service. Agent edits
    // one file in each repo during a single heal iteration. The journal's
    // fix.file should list both absolute paths, and both services should
    // restart based on the diff matching their service cwds.
    const repo2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-r2-')))
    for (const dir of [tmpDir, repo2]) {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
      fs.writeFileSync(path.join(dir, 'main.ts'), '// initial\n')
      execFileSync('git', ['add', 'main.ts'], { cwd: dir })
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
    }

    const f = makeFakeFactory()
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature({
        repos: [
          {
            name: 'api',
            localPath: tmpDir,
            startCommands: [{ command: 'echo hi', name: 'api', healthCheck: { url: 'http://x' } }],
          },
          {
            name: 'worker',
            localPath: repo2,
            startCommands: [{ command: 'echo hi', name: 'worker', healthCheck: { url: 'http://y' } }],
          },
        ],
      }),
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
    // Two services start in parallel → spawned[0], spawned[1]; spawned[2] = pw.
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitExit(1)
    // spawned[3] = heal agent.
    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    // Agent edits files in BOTH repos during its turn.
    fs.writeFileSync(path.join(tmpDir, 'main.ts'), '// edited 1\n')
    fs.writeFileSync(path.join(repo2, 'main.ts'), '// edited 2\n')
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({
      hypothesis: 'fix both',
      fixDescription: 'edited both repos',
    }))
    f.spawned[3].emitExit(0)
    // After the signal: both services restart (spawned[4], spawned[5]), then pw reruns (spawned[6]).
    while (f.spawned.length < 7) await new Promise((r) => setTimeout(r, 5))
    f.spawned[6].emitExit(1)
    await promise

    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    // fix.file aggregates absolute paths from both repos.
    expect(journal).toMatch(/- fix\.file: .+main\.ts, .+main\.ts/)
    expect(journal).toContain(path.join(tmpDir, 'main.ts'))
    expect(journal).toContain(path.join(repo2, 'main.ts'))
    // The ### Diff subsection records the actual content change from both
    // repos. Multi-repo features get a `# repo:` header per repo so a human
    // (and the heal agent on cycle 2) can tell hunks apart.
    expect(journal).toContain('### Diff')
    expect(journal).toContain('```diff')
    expect(journal).toContain(`# repo: ${tmpDir}`)
    expect(journal).toContain(`# repo: ${repo2}`)
    expect(journal).toMatch(/^-\/\/ initial$/m)
    expect(journal).toMatch(/^\+\/\/ edited 1$/m)
    expect(journal).toMatch(/^\+\/\/ edited 2$/m)
    // Both services were restarted because the diff matched both service cwds.
    const m = readManifest(orch.paths.manifestPath)!
    const history = (m as { healCycleHistory: Array<{ cycle: number; restarted: string[]; kept: string[] }> }).healCycleHistory
    expect(history[0].restarted.sort()).toEqual(['api', 'worker'])
    await orch.stop('failed')
  }, 15000)

  it('omits fix.file in non-git workspaces and falls back to restart-all', async () => {
    // No git init on tmpDir → snapshotFeatureRepos sees no working tree, the
    // diff is empty, the journal omits fix.file, and restart() with an empty
    // filesChanged respawns every service (the previous "restart all" path).
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
      autoHeal: { agent: 'claude', maxCycles: 1, buildCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({
      hypothesis: 'fix',
      fixDescription: 'd',
    }))
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 5) await new Promise((r) => setTimeout(r, 5))
    f.spawned[4].emitExit(1)
    await promise

    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    expect(journal).toContain('- hypothesis: fix')
    expect(journal).not.toContain('- fix.file:')
    // The api service was respawned despite the empty diff (restart-all path).
    expect(f.spawned.length).toBeGreaterThanOrEqual(5)
    await orch.stop('failed')
  }, 15000)

  it('honors .rerun signal (rerun-only path)', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1, 0], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a', location: 'e2e/a.spec.ts:9' }] }),
    )
    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.rerunSignal, '')
    f.spawned[2].emitExit(0)

    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('running')
    expect(statuses.at(-1)).toBe('running')
    expect(f.spawned[3].options.command).toContain('e2e/a.spec.ts:9')
    // Mimic the SummaryReporter clearing the failed entry on a successful rerun.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passedNames: ['a'],
      failed: [],
    }))
    f.spawned[3].emitExit(0)
    const status = await promise
    expect(status).toBe('passed')
    await orch.stop('passed')
  })

  it('falls back to full-suite post-heal rerun when failed entries have no location', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1, 0], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }] }),
    )
    const chunks: string[] = []
    orch.on('playwright-output', (e) => chunks.push(e.chunk))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.rerunSignal, '')
    f.spawned[2].emitExit(0)

    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    expect(f.spawned[3].options.command).toBe('pw-1')
    expect(chunks.join('')).toContain('running the full Playwright suite')
    // Mimic the SummaryReporter clearing the failed entry on a successful rerun.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passedNames: ['a'],
      failed: [],
    }))
    f.spawned[3].emitExit(0)
    expect(await promise).toBe('passed')
    await orch.stop('passed')
  })

  it('treats .heal signal as rerun-only in auto-heal mode', async () => {
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
    fs.writeFileSync(orch.paths.healSignal, JSON.stringify({ hypothesis: 'try again' }))
    f.spawned[2].emitExit(0)

    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    // Mimic the SummaryReporter clearing the failed entry on a successful rerun.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passedNames: ['a'],
      failed: [],
    }))
    f.spawned[3].emitExit(0)
    expect(await promise).toBe('passed')
    await orch.stop('passed')
	  })
})

describe('RunOrchestrator.restartTerminalRun', () => {
  it('starts by retesting failed, skipped, and pending tests without a full-suite first pass', async () => {
    const f = makeFakeFactory()
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.summaryPath, JSON.stringify({
      complete: true,
      total: 4,
      passed: 1,
      passedNames: ['test-case-a'],
      skipped: 1,
      skippedNames: ['test-case-c'],
      knownTests: [
        { name: 'test-case-a', title: 'A passed', location: `${featureDir}/e2e/spec.ts:10` },
        { name: 'test-case-b', title: 'B failed', location: `${featureDir}/e2e/spec.ts:20` },
        { name: 'test-case-c', title: 'C skipped', location: `${featureDir}/e2e/spec.ts:30` },
        { name: 'test-case-d', title: 'D pending', location: `${featureDir}/e2e/spec.ts:40` },
      ],
      failed: [{ name: 'test-case-b', location: `${featureDir}/e2e/spec.ts:20` }],
    }))
    const selections: unknown[] = []
    const orch = new RunOrchestrator({
      feature: makeFeature({ featureDir, repos: undefined }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      playwrightSpawner: ({ rerunSelection }) => {
        selections.push(rerunSelection)
        return { command: 'pw', cwd: tmpDir }
      },
    })

    const promise = orch.restartTerminalRun()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(f.spawned).toHaveLength(1)
    f.spawned[0].emitExit(1)
    await promise

    expect(selections[0]).toMatchObject({
      kind: 'grep',
      selected: 3,
      total: 4,
      mode: 'failed-and-pending',
    })
    expect((selections[0] as { reason: string }).reason).toContain('1 failed first, then 1 skipped, then 1 pending/not-run')
    expect(f.spawned[0].options.env?.CANARY_LAB_TARGETED_RERUN).toBe('1')
  })
})

describe('RunOrchestrator.waitForHealSignal', () => {
  it('accepts one signal while waiting and ignores duplicate pending signals', async () => {
    vi.useFakeTimers()
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 10,
      healSignalPollMs: 10,
    })
    await orch.start()
    const ignored: string[] = []
    orch.on('signal-ignored', (e) => ignored.push(e.reason))
    const waiting = orch.waitForHealSignal(5_000, 5_000, false)
    fs.writeFileSync(orch.paths.restartSignal, '{"hypothesis":"h"}')
    fs.writeFileSync(orch.paths.rerunSignal, '{}')

    vi.advanceTimersByTime(20)
    await Promise.resolve()
    const { signal, reason } = await waiting
    vi.useRealTimers()

    expect(signal?.kind).toBe('restart')
    expect(reason).toBe('signal')
    expect(ignored).toContain('signal-already-pending')
    expect(readManifest(orch.paths.manifestPath)?.lifecycle?.lastSignal?.status).toBe('ignored')
    await orch.stop('aborted')
  })

  it('returns pty-died when no agent pty is alive (post-exit grace then bail)', async () => {
    // With no live heal-agent pty, the `pty-died` grace path is what gets
    // exercised — the hard/idle timeouts only apply while the REPL is up.
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
    const { signal, reason } = await orch.waitForHealSignal(5_000, 5_000)
    expect(signal).toBeNull()
    expect(reason).toBe('pty-died')
  })

  it('returns stopped when the orchestrator has been aborted', async () => {
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
    const { signal, reason } = await orch.waitForHealSignal(50, 50)
    expect(signal).toBeNull()
    expect(reason).toBe('stopped')
  })
})

describe('RunOrchestrator.runHealAgent', () => {
  it('throws when auto-heal is not configured', async () => {
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      delay: async () => undefined,
    })
    await expect(orch.runHealAgent({ cycle: 1, failedSlugs: [] })).rejects.toThrow(/autoHeal/)
  })

  it('submits a real prompt message to the live REPL on cycle 2+', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1, repos: [] }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      autoHeal: {
        agent: 'claude',
        buildSpawnCommand: ({ promptFile }) => `claude -- ${JSON.stringify(`@${promptFile}`)}`,
        buildCyclePrompt: () => 'cycle prompt',
      },
    })
    await orch.start()

    const first = orch.runHealAgent({ cycle: 1, failedSlugs: ['a'] })
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.rerunSignal, '{}')
    expect(await first).toMatchObject({ reason: 'signal', signal: { kind: 'rerun' } })

    const agent = f.spawned[0]
    const beforeWrites = agent.writes.length
    const second = orch.runHealAgent({ cycle: 2, failedSlugs: ['a'] })
    while (agent.writes.length === beforeWrites) await new Promise((r) => setTimeout(r, 5))

    const cyclePromptWrite = agent.writes.slice(beforeWrites).join('')
    const promptPath = path.join(runDir, 'heal-prompt.md')
    expect(cyclePromptWrite).toContain('\x1b[200~')
    expect(cyclePromptWrite).toContain(`Read ${promptPath} and continue the auto-heal cycle now.`)
    expect(cyclePromptWrite).toContain('\x1b[201~\r')
    expect(cyclePromptWrite).not.toContain(`@${promptPath}`)

    fs.writeFileSync(orch.paths.rerunSignal, '{}')
    expect(await second).toMatchObject({ reason: 'signal', signal: { kind: 'rerun' } })
    await orch.stop('failed')
  })
})

describe('readSummary / extractFailedSlugs / defaultPlaywrightSpawner / defaultSpawnCommand / defaultHealPrompt', () => {
  it('readSummary tolerates missing file', async () => {
    const { readSummary, extractFailedSlugs, extractFailedLocations, defaultPlaywrightSpawner, defaultSpawnCommand, defaultHealPrompt } =
      await import('./orchestrator')
    expect(readSummary(path.join(tmpDir, 'nope.json'))).toEqual({})
    expect(extractFailedSlugs({ failed: [{ name: 'a' }, { name: '' }, {}] })).toEqual(['a'])
    expect(extractFailedSlugs({})).toEqual([])
    expect(extractFailedLocations({
      failed: [
        { name: 'a', location: 'e2e/a.spec.ts:10' },
        { name: 'b', location: 'e2e/a.spec.ts:10' },
        { name: 'c', location: 'not-a-playwright-location' },
      ],
    })).toEqual(['e2e/a.spec.ts:10'])
    const f = makeFeature()
    const inv = defaultPlaywrightSpawner({ feature: f, paths: buildRunPaths(runDir) })
    expect(inv.command).toContain('playwright test')
    expect(inv.command).toContain(`--output=${JSON.stringify(path.join(runDir, 'playwright-artifacts'))}`)
    expect(inv.cwd).toBe(f.featureDir)
    const targeted = defaultPlaywrightSpawner({
      feature: f,
      paths: buildRunPaths(runDir),
      rerunTargets: ['e2e/a.spec.ts:10', 'e2e/b spec.ts:20'],
    })
    expect(targeted.command).toContain(`${JSON.stringify('e2e/a.spec.ts:10')} ${JSON.stringify('e2e/b spec.ts:20')}`)
    // The default spawn keeps the pty alive (via `cat`) so tests can write
    // prompts to its stdin without the REPL exiting underneath them.
    expect(defaultSpawnCommand({})).toBe('cat')
    expect(defaultHealPrompt({ cycle: 2, outputDir: '/x' })).toContain('cycle=2')
  })
})

describe('computeNonPassedTargets', () => {
  function writeSpec(featureDir: string, name: string, body: string): string {
    const dir = path.join(featureDir, 'e2e')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }

  it('returns failed + pending tests, skipping the ones already passed', async () => {
    const { computeNonPassedTargets } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    const specA = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('a happy path', async () => {})\n" +
      "test('b sad path', async () => {})\n",
    )
    const specB = writeSpec(featureDir, 'b.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('c never ran', async () => {})\n",
    )

    const result = computeNonPassedTargets(featureDir, {
      passedNames: ['test-case-a-happy-path'],
      failed: [{ name: 'test-case-b-sad-path', location: `${specA}:3` }],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.total).toBe(3)
    // Failed (b) at line 3 of spec A + pending (c) at line 2 of spec B; the
    // already-passed (a) at line 2 of spec A must NOT appear.
    expect(result.locations.sort()).toEqual([`${specA}:3`, `${specB}:2`].sort())
    expect(result.locations).not.toContain(`${specA}:2`)
  })

  it('returns no-passed-yet on a fresh run with no passedNames', async () => {
    const { computeNonPassedTargets } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('a', async () => {})\n",
    )
    const result = computeNonPassedTargets(featureDir, {})
    expect(result.kind).toBe('no-passed-yet')
  })

  it('returns all-passed when every test is in passedNames', async () => {
    const { computeNonPassedTargets } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('only one', async () => {})\n",
    )
    const result = computeNonPassedTargets(featureDir, {
      passedNames: ['test-case-only-one'],
    })
    expect(result.kind).toBe('all-passed')
  })

  it('returns extraction-failed when no spec files exist', async () => {
    const { computeNonPassedTargets } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'empty')
    fs.mkdirSync(featureDir, { recursive: true })
    const result = computeNonPassedTargets(featureDir, { passedNames: ['x'] })
    expect(result.kind).toBe('extraction-failed')
  })
})

describe('computeRerunTargetsOrdered', () => {
  function writeSpec(featureDir: string, name: string, body: string): string {
    const dir = path.join(featureDir, 'e2e')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }

  it('orders previously-failed tests first, then pending in source order', async () => {
    const { computeRerunTargetsOrdered } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo-ordered')
    fs.mkdirSync(featureDir, { recursive: true })
    // Spec layout: pending at line 2, failed at line 3 (failure comes AFTER
    // pending in source order — proves failed-first ordering isn't just
    // accidental source order).
    const specA = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('a pending one', async () => {})\n" +
      "test('a failing one', async () => {})\n",
    )
    const specB = writeSpec(featureDir, 'b.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('b another pending', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, {
      passedNames: ['test-case-something-already-passed'],
      failed: [{ name: 'test-case-a-failing-one', location: `${specA}:3` }],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst).toEqual([`${specA}:3`])
    expect(result.pending).toEqual([`${specA}:2`, `${specB}:2`])
    expect(result.locations).toEqual([`${specA}:3`, `${specA}:2`, `${specB}:2`])
    expect(result.droppedFailedSlugs).toEqual([])
    expect(result.total).toBe(3)
  })

  it('drops failed slugs that no longer exist in the AST and reports them', async () => {
    const { computeRerunTargetsOrdered } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo-dropped')
    fs.mkdirSync(featureDir, { recursive: true })
    const specA = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('renamed test', async () => {})\n" +
      "test('still here', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, {
      passedNames: ['test-case-still-here'],
      failed: [
        { name: 'test-case-old-name-that-was-renamed', location: `${specA}:3` },
        { name: 'test-case-deleted-entirely', location: `${specA}:99` },
      ],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst).toEqual([])
    expect(result.pending).toEqual([`${specA}:2`])
    expect(result.droppedFailedSlugs.sort()).toEqual([
      'test-case-deleted-entirely',
      'test-case-old-name-that-was-renamed',
    ])
  })

  it('returns pending-only when every prior-failed slug has since passed', async () => {
    const { computeRerunTargetsOrdered } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo-recovered')
    fs.mkdirSync(featureDir, { recursive: true })
    const specA = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('was failing now passing', async () => {})\n" +
      "test('pending one', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, {
      passedNames: ['test-case-was-failing-now-passing'],
      // The same slug is still listed in summary.failed (stale) — the helper
      // should ignore it because the slug is also in passedNames.
      failed: [{ name: 'test-case-was-failing-now-passing', location: `${specA}:2` }],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst).toEqual([])
    expect(result.pending).toEqual([`${specA}:3`])
    expect(result.locations).toEqual([`${specA}:3`])
  })

  it('handles empty passedNames by listing failed-first then everything else', async () => {
    const { computeRerunTargetsOrdered } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo-no-passed')
    fs.mkdirSync(featureDir, { recursive: true })
    const specA = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('first', async () => {})\n" +
      "test('second', async () => {})\n" +
      "test('third', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, {
      failed: [{ name: 'test-case-third', location: `${specA}:4` }],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst).toEqual([`${specA}:4`])
    expect(result.pending).toEqual([`${specA}:2`, `${specA}:3`])
    expect(result.locations).toEqual([`${specA}:4`, `${specA}:2`, `${specA}:3`])
  })

  it('returns all-passed when every AST test is in passedNames', async () => {
    const { computeRerunTargetsOrdered } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo-all-passed')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('only one', async () => {})\n",
    )
    const result = computeRerunTargetsOrdered(featureDir, {
      passedNames: ['test-case-only-one'],
    })
    expect(result.kind).toBe('all-passed')
  })

  it('returns extraction-failed when there are no spec files', async () => {
    const { computeRerunTargetsOrdered } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo-empty')
    fs.mkdirSync(featureDir, { recursive: true })
    const result = computeRerunTargetsOrdered(featureDir, { passedNames: ['x'] })
    expect(result.kind).toBe('extraction-failed')
  })
})

describe('computeVerificationPlan', () => {
  it('uses knownTests to target factory-generated failed and pending tests by title', async () => {
    const { computeVerificationPlan } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo-known')
    fs.mkdirSync(featureDir, { recursive: true })

    const result = computeVerificationPlan(featureDir, {
      passed: 1,
      passedNames: ['test-case-already-passed'],
      total: 3,
      knownTests: [
        { name: 'test-case-already-passed', title: 'already passed', location: `${featureDir}/e2e/helpers/spec-factory.ts:54` },
        { name: 'test-case-factory-failed', title: 'en_SG: checkout — address + payment pages', location: `${featureDir}/e2e/helpers/spec-factory.ts:58` },
        { name: 'test-case-factory-pending', title: 'en_SG: payment — authorize branch end-to-end', location: `${featureDir}/e2e/helpers/spec-factory.ts:63` },
      ],
      failed: [
        { name: 'test-case-factory-failed', location: `${featureDir}/e2e/helpers/spec-factory.ts:58` },
      ],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.selection.kind).toBe('grep')
    if (result.selection.kind !== 'grep') return
	    expect(result.failedFirst.map((test) => test.name)).toEqual(['test-case-factory-failed'])
	    expect(result.skipped.map((test) => test.name)).toEqual([])
	    expect(result.pending.map((test) => test.name)).toEqual(['test-case-factory-pending'])
    expect(result.selection.grep).toContain('en_SG: checkout')
    expect(result.selection.grep).toContain('en_SG: payment')
	  })

  it('orders remaining known tests as failed, skipped, then pending', async () => {
    const { computeVerificationPlan } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo-known-order')
    fs.mkdirSync(featureDir, { recursive: true })

    const result = computeVerificationPlan(featureDir, {
      passed: 1,
      passedNames: ['test-case-a'],
      skippedNames: ['test-case-c'],
      total: 4,
      knownTests: [
        { name: 'test-case-a', title: 'A passed', location: `${featureDir}/e2e/spec.ts:10` },
        { name: 'test-case-b', title: 'B failed', location: `${featureDir}/e2e/spec.ts:20` },
        { name: 'test-case-c', title: 'C skipped', location: `${featureDir}/e2e/spec.ts:30` },
        { name: 'test-case-d', title: 'D pending', location: `${featureDir}/e2e/spec.ts:40` },
      ],
      failed: [
        { name: 'test-case-b', location: `${featureDir}/e2e/spec.ts:20` },
      ],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst.map((test) => test.name)).toEqual(['test-case-b'])
    expect(result.skipped.map((test) => test.name)).toEqual(['test-case-c'])
    expect(result.pending.map((test) => test.name)).toEqual(['test-case-d'])
    expect(result.selection.reason).toContain('1 failed first, then 1 skipped, then 1 pending/not-run')
  })

  it('falls back to full-suite when failed tests cannot be safely selected', async () => {
    const { computeVerificationPlan } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo-unsafe')
    fs.mkdirSync(featureDir, { recursive: true })

    const result = computeVerificationPlan(featureDir, {
      total: 3,
      passedNames: ['test-case-a'],
      failed: [
        { name: 'test-case-helper-fail', location: `${featureDir}/e2e/helpers/spec-factory.ts:58` },
      ],
    })

    expect(result.kind).toBe('full-suite')
    if (result.kind !== 'full-suite') return
    expect(result.reason).toContain('full Playwright suite')
  })
})

describe('decideRunStatus', () => {
  function writeSpec(featureDir: string, name: string, body: string): string {
    const dir = path.join(featureDir, 'e2e')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }

  function writeSummary(summaryPath: string, summary: object): void {
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
    fs.writeFileSync(summaryPath, JSON.stringify(summary))
  }

  it('returns failed on any non-zero exit code regardless of summary', async () => {
    const { decideRunStatus } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('a', async () => {})\n",
    )
    const summaryPath = path.join(tmpDir, 'summary.json')
    writeSummary(summaryPath, { passedNames: ['test-case-a'] })
    expect(decideRunStatus(featureDir, summaryPath, 1)).toBe('failed')
  })

  it('returns passed when exit 0 and every AST test is in passedNames', async () => {
    const { decideRunStatus } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('first', async () => {})\n" +
      "test('second', async () => {})\n",
    )
    const summaryPath = path.join(tmpDir, 'summary.json')
    writeSummary(summaryPath, { passedNames: ['test-case-first', 'test-case-second'] })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('passed')
  })

  it('returns failed on exit 0 when summary still has a failed entry', async () => {
    const { decideRunStatus } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    const spec = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('first', async () => {})\n" +
      "test('second', async () => {})\n",
    )
    const summaryPath = path.join(tmpDir, 'summary.json')
    writeSummary(summaryPath, {
      passedNames: ['test-case-first'],
      failed: [{ name: 'test-case-second', location: `${spec}:3` }],
    })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('failed')
  })

  it('returns failed on exit 0 when an AST test is pending (missing from summary)', async () => {
    const { decideRunStatus } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('first', async () => {})\n" +
      "test('second', async () => {})\n",
    )
    const summaryPath = path.join(tmpDir, 'summary.json')
    // Only `first` ran; `second` never made it into the summary at all.
    writeSummary(summaryPath, { passedNames: ['test-case-first'] })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('failed')
  })

  it('returns failed on exit 0 when an AST test is in skippedNames', async () => {
    const { decideRunStatus } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('first', async () => {})\n" +
      "test('second', async () => {})\n",
    )
    const summaryPath = path.join(tmpDir, 'summary.json')
    writeSummary(summaryPath, {
      passedNames: ['test-case-first'],
      skipped: 1,
      skippedNames: ['test-case-second'],
    })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('failed')
  })

  it('falls back to summarizeFailures when AST extraction fails (no parseable specs)', async () => {
    const { decideRunStatus } = await import('./orchestrator')
    const featureDir = path.join(tmpDir, 'features', 'no-specs')
    fs.mkdirSync(featureDir, { recursive: true })
    const summaryPath = path.join(tmpDir, 'summary.json')

    // Empty failed[] + exit 0 + no parseable specs => passed (legacy behavior).
    writeSummary(summaryPath, { passedNames: [] })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('passed')

    // Failed entry + exit 0 + no parseable specs => failed.
    writeSummary(summaryPath, { failed: [{ name: 'test-case-x' }] })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('failed')
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
      autoHeal: { agent: 'claude', maxCycles: 1, buildCommand: () => `heal-${healIdx++}` },
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
    expect(orch.status).toBe('healing')
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
      autoHeal: { agent: 'claude', maxCycles: 1, buildCommand: () => `heal-${healIdx++}` },
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

    expect(orch.status).toBe('healing')
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

  it('succeeds even when healing-but-no-pty (REPL exited unexpectedly)', async () => {
    // Regression: when claude's REPL crashes / exits via `/exit` mid-cycle,
    // the orchestrator nulls `healAgentPty` but stays in `'healing'` until
    // `waitForHealSignal` notices. The user's only way out is cancel — and
    // it MUST succeed (set the cancel flag, return ok) even when there's
    // no live pty to SIGTERM, so the loop bails on its next tick.
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
    })
    orch.setStatus('healing')
    expect(await orch.cancelHeal()).toEqual({ ok: true })
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

  it('also accepts cancel during the post-heal Playwright rerun (status=running, healCycles>0)', async () => {
    // Regression: between cycles the orchestrator flips status to `running`
    // for the Playwright rerun. Stop Heal clicked during that window used
    // to silently 409 (`not-healing`). Now `cancelHeal` accepts it,
    // SIGTERMs the playwright pty, and the loop's post-Playwright
    // `healCancelled` check finalizes the run as `failed`.
    fs.mkdirSync(runDir, { recursive: true })
    const f = makeFakeFactory()
    let pwIdx = 0
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
      autoHeal: {
        agent: 'claude',
        maxCycles: 5,
        buildSpawnCommand: () => 'cat',
        buildCyclePrompt: () => 'prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a', location: 'e2e/a.spec.ts:1' }] }),
    )
    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))

    const promise = orch.runFullCycle()
    // Drive: services boot + Playwright fails → heal agent (status=healing).
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Agent writes a .rerun signal to advance the loop into the
    // post-heal Playwright phase (status flips to `running`).
    fs.writeFileSync(orch.paths.rerunSignal, JSON.stringify({ hypothesis: 'try again' }))
    while (!statuses.includes('running')) await new Promise((r) => setTimeout(r, 5))
    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    const pwPty = f.spawned[3]

    // User clicks Stop Heal mid-Playwright.
    const result = await orch.cancelHeal()
    expect(result).toEqual({ ok: true })
    expect(pwPty.killed).toBe('SIGTERM')
    pwPty.emitExit(143)

    const finalStatus = await promise
    expect(finalStatus).toBe('failed')
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly?.reason).toBe('user-cancel-heal')
    await orch.stop('failed')
  }, 10000)

  it('killTree sends SIGTERM to the process group (negative pid) before falling back', async () => {
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
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    const agentPty = f.spawned[2]
    await orch.cancelHeal()
    // Negative pid → process-group kill of the agent's pty.
    expect(killSpy).toHaveBeenCalledWith(-agentPty.pid, 'SIGTERM')
    // Fallback path also fired (fake pty's kill recorded the signal).
    expect(agentPty.killed).toBe('SIGTERM')
    killSpy.mockRestore()
    agentPty.emitExit(143)
    await promise
    await orch.stop('failed')
  })
})

describe('RunOrchestrator.interjectHealAgent', () => {
  it('returns no-agent-running when no heal pty is in flight', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
    })
    const result = await orch.interjectHealAgent('nudge')
    expect(result).toEqual({ ok: false, reason: 'no-agent-running' })
  })

  it('writes Esc + text + Enter to the live REPL stdin without respawning', async () => {
    fs.mkdirSync(runDir, { recursive: true })
    const f = makeFakeFactory()
    let pwIdx = 0
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
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: () => 'claude --dangerously-skip-permissions',
        buildCyclePrompt: ({ cycle }) => `cycle-${cycle}-prompt`,
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 3, passed: 0 }),
    )
    const agentChunks: string[] = []
    orch.on('agent-output', ({ chunk }) => agentChunks.push(chunk))
    const statusEvents: string[] = []
    orch.on('run-status', ({ status }) => statusEvents.push(status))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    // Wait for the REPL to spawn (idx 2 = agent, after services + playwright).
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    const agent = f.spawned[2]
    // Drain the cycle-1 prompt write from pty.write so we can assert the
    // interject writes cleanly afterward.
    const writeMock = (agent as unknown as { options: PtySpawnOptions }).options
    void writeMock
    // The interject lands as Esc + text + Enter. No new pty is spawned —
    // the existing REPL keeps running.
    const beforeSpawnCount = f.spawned.length
    const result = await orch.interjectHealAgent('nudge fix')
    expect(result).toEqual({ ok: true })
    expect(f.spawned.length).toBe(beforeSpawnCount)
    // Agent-output stream echoes the user's redirect block to live xterm.
    const echoed = agentChunks.join('')
    expect(echoed).toContain('user interject')
    expect(echoed).toContain('  │ nudge fix')
    // Status stays in healing — interject does not flip the run state.
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('healing')
    expect(statusEvents).not.toContain('running')
    // The fake pty's write was called with the Esc preamble + text + \r.
    // (FakeProcess uses `write: vi.fn()` so it captures every call.)
    const ptyWrite = (orch as unknown as { healAgentPty: { write: ReturnType<typeof vi.fn> } | null }).healAgentPty?.write
    expect(ptyWrite).toBeDefined()
    const writeCalls = (ptyWrite as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]).join('')
    expect(writeCalls).toContain('nudge fix')
    expect(writeCalls).toContain('')

    // Let the loop time out (no signal landed) and exit cleanly.
    await promise
    await orch.stop('failed')
  })

  it('preserves multi-line user interject text in the pane and transcript', async () => {
    fs.mkdirSync(runDir, { recursive: true })
    const f = makeFakeFactory()
    let pwIdx = 0
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
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: () => 'claude',
        buildCyclePrompt: () => 'cycle-prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 3, passed: 0 }),
    )
    const agentChunks: string[] = []
    orch.on('agent-output', ({ chunk }) => agentChunks.push(chunk))
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    const beforeSpawnCount = f.spawned.length

    expect(await orch.interjectHealAgent('first line\nsecond line\nthird line')).toEqual({ ok: true })
    expect(f.spawned.length).toBe(beforeSpawnCount) // no respawn
    const echoed = agentChunks.join('')
    expect(echoed).toContain('  │ first line\n  │ second line\n  │ third line')

    await promise
    await orch.stop('failed')
  })
})

describe('RunOrchestrator.restartHealFromFailure', () => {
  it('starts the heal agent without a fresh Playwright run and passes user guidance into the command builder', async () => {
    const f = makeFakeFactory()
    let receivedGuidance: string | undefined
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 20,
      playwrightSpawner: () => ({ command: 'pw-should-not-run', cwd: tmpDir }),
      autoHeal: {
        agent: 'codex',
        maxCycles: 1,
        buildSpawnCommand: () => 'codex heal restart',
        buildCyclePrompt: ({ userGuidance }) => {
          receivedGuidance = userGuidance
          return `restart-prompt`
        },
      },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )
    const agentChunks: string[] = []
    orch.on('agent-output', ({ chunk }) => agentChunks.push(chunk))
    const serviceStarts: string[] = []
    orch.on('service-started', ({ service }) => serviceStarts.push(service.name))

    const promise = orch.restartHealFromFailure('look at fallback country mapping')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(f.spawned[0].options.command).toBe('codex heal restart')
    expect(receivedGuidance).toBe('look at fallback country mapping')
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('healing')
    expect(serviceStarts).toEqual([])
    const echoed = agentChunks.join('')
    expect(echoed).toContain('user interject')
    expect(echoed).toContain('  │ look at fallback country mapping')
    f.spawned[0].emitExit(0)

    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('starts services only after the restarted heal agent requests a rerun', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      playwrightSpawner: () => ({ command: 'pw-after-heal', cwd: tmpDir }),
      autoHeal: {
        agent: 'codex',
        maxCycles: 1,
        buildSpawnCommand: () => 'codex heal restart',
        buildCyclePrompt: () => 'restart-prompt',
      },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )
    const eventLog: string[] = []
    orch.on('agent-started', () => eventLog.push('agent-started'))
    orch.on('agent-exit', () => eventLog.push('agent-exit'))
    orch.on('signal-accepted', (e) => eventLog.push(`signal:${e.kind}`))
    orch.on('service-started', () => eventLog.push('service-started'))
    orch.on('playwright-started', () => eventLog.push('playwright-started'))

    const promise = orch.restartHealFromFailure('rerun after this')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(f.spawned[0].options.command).toBe('codex heal restart')
    expect(eventLog).toEqual(['agent-started'])

    fs.writeFileSync(orch.paths.rerunSignal, JSON.stringify({ hypothesis: 'try again' }))
    while (!eventLog.includes('signal:rerun')) await new Promise((r) => setTimeout(r, 5))
    // REPL stays alive across cycles in REPL mode — no per-cycle exit.
    // Wait for services + playwright to spawn (agent is idx 0).
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    expect(eventLog).toEqual([
      'agent-started',
      'signal:rerun',
      'service-started',
      'playwright-started',
    ])

    // Playwright passes — loop ends, cleanupHealAgentPty fires agent-exit.
    // Mimic the SummaryReporter clearing the failed entry so decideRunStatus
    // sees the rerun as a real success.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passedNames: ['a'],
      failed: [],
      total: 1,
      passed: 1,
    }))
    f.spawned[2].emitExit(0)
    expect(await promise).toBe('passed')
    expect(eventLog).toContain('agent-exit')
    await orch.stop('passed')
  })

  it('claude restart: reuses the prior session id from disk and passes resume=true to the spawn-command builder', async () => {
    // On Restart Heal the run dir already carries the previous heal session's
    // UUID at `agent-session-id.txt`. We reuse it so the spawn command can
    // emit `--resume <uuid>` and claude continues the prior conversation
    // instead of orphaning all the investigation history.
    const PRIOR_SID = 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f'
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionIdPath, PRIOR_SID)

    const f = makeFakeFactory()
    const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 20,
      playwrightSpawner: () => ({ command: 'pw-should-not-run', cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: ({ sessionId, resume }) => {
          spawnCalls.push({ sessionId, resume })
          return 'claude heal restart'
        },
        buildCyclePrompt: () => 'restart-prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )

    const promise = orch.restartHealFromFailure('look again')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]).toEqual({ sessionId: PRIOR_SID, resume: true })
    // File is preserved unchanged — same UUID across the restart so the UI
    // shows a stable session and `locateClaudeSessionLog` finds the same
    // ~/.claude/projects/.../<uuid>.jsonl after resume.
    expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(PRIOR_SID)
    f.spawned[0].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('claude restart: when no prior session id file exists, generates a fresh UUID with resume=false', async () => {
    // First-ever heal cycle (or a corrupt/missing sid file) falls back to
    // the original behavior: mint a new UUID, spawn with --session-id.
    const paths = buildRunPaths(runDir)
    expect(fs.existsSync(paths.agentSessionIdPath)).toBe(false)

    const f = makeFakeFactory()
    const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 20,
      playwrightSpawner: () => ({ command: 'pw-should-not-run', cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: ({ sessionId, resume }) => {
          spawnCalls.push({ sessionId, resume })
          return 'claude heal fresh'
        },
        buildCyclePrompt: () => 'fresh-prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )

    const promise = orch.restartHealFromFailure('look again')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].resume).toBe(false)
    expect(spawnCalls[0].sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    // File was written so a SUBSEQUENT restart could resume this same session.
    expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(spawnCalls[0].sessionId)
    f.spawned[0].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('claude restart: corrupt prior-session-id file is ignored — generates a fresh UUID with resume=false', async () => {
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionIdPath, 'not-a-uuid')

    const f = makeFakeFactory()
    const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 20,
      playwrightSpawner: () => ({ command: 'pw-should-not-run', cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: ({ sessionId, resume }) => {
          spawnCalls.push({ sessionId, resume })
          return 'claude heal recover'
        },
        buildCyclePrompt: () => 'recover-prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )

    const promise = orch.restartHealFromFailure('look again')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(spawnCalls[0].resume).toBe(false)
    expect(spawnCalls[0].sessionId).not.toBe('not-a-uuid')
    expect(spawnCalls[0].sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    // The corrupt file was overwritten with the freshly minted UUID.
    expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(spawnCalls[0].sessionId)
    f.spawned[0].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('claude restart: recovers a missing pointer from the native Claude session log', async () => {
    const PRIOR_SID = 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f'
    const paths = buildRunPaths(runDir)
    const locateSpy = vi.spyOn(sessionLog, 'locateLatestSessionLogForAgent').mockReturnValue({
      agent: 'claude',
      sessionId: PRIOR_SID,
      logPath: '/tmp/claude-session.jsonl',
    })

    try {
      const f = makeFakeFactory()
      const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
      const orch = new RunOrchestrator({
        feature: makeFeature({ healOnFailureThreshold: 1 }),
        runId: RUN_ID,
        runDir,
        ptyFactory: f.factory,
        healthCheck: async () => true,
        delay: async () => undefined,
        healSignalPollMs: 1,
        healAgentTimeoutMs: 20,
        playwrightSpawner: () => ({ command: 'pw-should-not-run', cwd: tmpDir }),
        autoHeal: {
          agent: 'claude',
          maxCycles: 1,
          buildSpawnCommand: ({ sessionId, resume }) => {
            spawnCalls.push({ sessionId, resume })
            return 'claude heal restart'
          },
          buildCyclePrompt: () => 'restart-prompt',
        },
      })
      fs.writeFileSync(
        orch.paths.summaryPath,
        JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
      )

      const promise = orch.restartHealFromFailure('look again')
      while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
      expect(locateSpy).toHaveBeenCalledWith('claude', runDir)
      expect(spawnCalls).toEqual([{ sessionId: PRIOR_SID, resume: true }])
      expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(PRIOR_SID)
      expect(JSON.parse(fs.readFileSync(paths.agentSessionRefPath, 'utf-8'))).toEqual({
        activeAgent: 'claude',
        sessions: {
          claude: {
            agent: 'claude',
            sessionId: PRIOR_SID,
            logPath: '/tmp/claude-session.jsonl',
          },
        },
      })
      f.spawned[0].emitExit(0)
      expect(await promise).toBe('failed')
      await orch.stop('failed')
    } finally {
      locateSpy.mockRestore()
    }
  })

  it('claude restart: injects previous Codex session context into the heal prompt', async () => {
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionRefPath, JSON.stringify({
      agent: 'codex',
      sessionId: '019e1779-6b55-73b1-8ab7-e8e345bd889a',
      logPath: '/tmp/codex-session.jsonl',
    }))
    fs.writeFileSync(paths.agentSessionIdPath, '019e1779-6b55-73b1-8ab7-e8e345bd889a')
    const renderSpy = vi.spyOn(sessionLog, 'renderAgentSessionContext')
      .mockReturnValue('Previous codex session 019e...\nASSISTANT: inspect fallback SMS call')

    try {
      const f = makeFakeFactory()
      let receivedContext: string | undefined
      const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
      const orch = new RunOrchestrator({
        feature: makeFeature({ healOnFailureThreshold: 1 }),
        runId: RUN_ID,
        runDir,
        ptyFactory: f.factory,
        healthCheck: async () => true,
        delay: async () => undefined,
        healSignalPollMs: 1,
        healAgentTimeoutMs: 20,
        playwrightSpawner: () => ({ command: 'pw-should-not-run', cwd: tmpDir }),
        autoHeal: {
          agent: 'claude',
          maxCycles: 1,
          buildSpawnCommand: ({ sessionId, resume }) => {
            spawnCalls.push({ sessionId, resume })
            return 'claude heal restart'
          },
          buildCyclePrompt: ({ priorAgentSessionContext }) => {
            receivedContext = priorAgentSessionContext
            return 'restart-prompt'
          },
        },
      })
      fs.writeFileSync(
        orch.paths.summaryPath,
        JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
      )

      const promise = orch.restartHealFromFailure('look again')
      while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
      expect(renderSpy).toHaveBeenCalledWith({
        agent: 'codex',
        sessionId: '019e1779-6b55-73b1-8ab7-e8e345bd889a',
        logPath: '/tmp/codex-session.jsonl',
      })
      expect(receivedContext).toContain('Previous codex session')
      expect(receivedContext).toContain('fallback SMS call')
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0].resume).toBe(false)
      expect(spawnCalls[0].sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
      f.spawned[0].emitExit(0)
      expect(await promise).toBe('failed')
      await orch.stop('failed')
    } finally {
      renderSpy.mockRestore()
    }
  })

  it('codex restart: reuses the prior session id from disk and passes resume=true', async () => {
    const PRIOR_SID = 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f'
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionIdPath, PRIOR_SID)

    const f = makeFakeFactory()
    const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 20,
      playwrightSpawner: () => ({ command: 'pw-should-not-run', cwd: tmpDir }),
      autoHeal: {
        agent: 'codex',
        maxCycles: 1,
        buildSpawnCommand: ({ sessionId, resume }) => {
          spawnCalls.push({ sessionId, resume })
          return 'codex heal restart'
        },
        buildCyclePrompt: () => 'restart-prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )

    const promise = orch.restartHealFromFailure('look again')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(spawnCalls).toEqual([{ sessionId: PRIOR_SID, resume: true }])
    f.spawned[0].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('codex restart: can reuse a prior session id from agent-session.json', async () => {
    const PRIOR_SID = 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f'
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionRefPath, JSON.stringify({
      agent: 'codex',
      sessionId: PRIOR_SID,
      logPath: '/tmp/codex-session.jsonl',
    }))

    const f = makeFakeFactory()
    const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 20,
      playwrightSpawner: () => ({ command: 'pw-should-not-run', cwd: tmpDir }),
      autoHeal: {
        agent: 'codex',
        maxCycles: 1,
        buildSpawnCommand: ({ sessionId, resume }) => {
          spawnCalls.push({ sessionId, resume })
          return 'codex heal restart'
        },
        buildCyclePrompt: () => 'restart-prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )

    const promise = orch.restartHealFromFailure('look again')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(spawnCalls).toEqual([{ sessionId: PRIOR_SID, resume: true }])
    expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(PRIOR_SID)
    f.spawned[0].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('codex restart: injects previous Claude session context into the heal prompt', async () => {
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionRefPath, JSON.stringify({
      agent: 'claude',
      sessionId: 'd5f3e235-2470-4a1c-bb31-2030880a1670',
      logPath: '/tmp/claude-session.jsonl',
    }))
    fs.writeFileSync(paths.agentSessionIdPath, 'd5f3e235-2470-4a1c-bb31-2030880a1670')
    const renderSpy = vi.spyOn(sessionLog, 'renderAgentSessionContext')
      .mockReturnValue('Previous claude session d5f3...\nASSISTANT: use FAKE_CNS_v1_BASE_URL')

    try {
      const f = makeFakeFactory()
      let receivedContext: string | undefined
      const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
      const orch = new RunOrchestrator({
        feature: makeFeature({ healOnFailureThreshold: 1 }),
        runId: RUN_ID,
        runDir,
        ptyFactory: f.factory,
        healthCheck: async () => true,
        delay: async () => undefined,
        healSignalPollMs: 1,
        healAgentTimeoutMs: 20,
        playwrightSpawner: () => ({ command: 'pw-should-not-run', cwd: tmpDir }),
        autoHeal: {
          agent: 'codex',
          maxCycles: 1,
          buildSpawnCommand: ({ sessionId, resume }) => {
            spawnCalls.push({ sessionId, resume })
            return 'codex heal restart'
          },
          buildCyclePrompt: ({ priorAgentSessionContext }) => {
            receivedContext = priorAgentSessionContext
            return 'restart-prompt'
          },
        },
      })
      fs.writeFileSync(
        orch.paths.summaryPath,
        JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
      )

      const promise = orch.restartHealFromFailure('look again')
      while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
      expect(renderSpy).toHaveBeenCalledWith({
        agent: 'claude',
        sessionId: 'd5f3e235-2470-4a1c-bb31-2030880a1670',
        logPath: '/tmp/claude-session.jsonl',
      })
      expect(receivedContext).toContain('Previous claude session')
      expect(receivedContext).toContain('FAKE_CNS_v1_BASE_URL')
      expect(spawnCalls).toEqual([{ sessionId: undefined, resume: false }])
      f.spawned[0].emitExit(0)
      expect(await promise).toBe('failed')
      await orch.stop('failed')
    } finally {
      renderSpy.mockRestore()
    }
  })

  it('codex restart: recovers a missing pointer from the native Codex session log', async () => {
    const PRIOR_SID = 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f'
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionRefPath, JSON.stringify({
      activeAgent: 'claude',
      sessions: {
        claude: {
          agent: 'claude',
          sessionId: 'd5f3e235-2470-4a1c-bb31-2030880a1670',
          logPath: '/tmp/claude-session.jsonl',
        },
      },
    }))
    const locateSpy = vi.spyOn(sessionLog, 'locateLatestSessionLogForAgent').mockReturnValue({
      agent: 'codex',
      sessionId: PRIOR_SID,
      logPath: '/tmp/codex-session.jsonl',
    })

    try {
      const f = makeFakeFactory()
      const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
      const orch = new RunOrchestrator({
        feature: makeFeature({ healOnFailureThreshold: 1 }),
        runId: RUN_ID,
        runDir,
        ptyFactory: f.factory,
        healthCheck: async () => true,
        delay: async () => undefined,
        healSignalPollMs: 1,
        healAgentTimeoutMs: 20,
        playwrightSpawner: () => ({ command: 'pw-should-not-run', cwd: tmpDir }),
        autoHeal: {
          agent: 'codex',
          maxCycles: 1,
          buildSpawnCommand: ({ sessionId, resume }) => {
            spawnCalls.push({ sessionId, resume })
            return 'codex heal restart'
          },
          buildCyclePrompt: () => 'restart-prompt',
        },
      })
      fs.writeFileSync(
        orch.paths.summaryPath,
        JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
      )

      const promise = orch.restartHealFromFailure('look again')
      while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
      expect(locateSpy).toHaveBeenCalledWith('codex', runDir)
      expect(spawnCalls).toEqual([{ sessionId: PRIOR_SID, resume: true }])
      expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(PRIOR_SID)
      expect(JSON.parse(fs.readFileSync(paths.agentSessionRefPath, 'utf-8'))).toEqual({
        activeAgent: 'codex',
        sessions: {
          claude: {
            agent: 'claude',
            sessionId: 'd5f3e235-2470-4a1c-bb31-2030880a1670',
            logPath: '/tmp/claude-session.jsonl',
          },
          codex: {
            agent: 'codex',
            sessionId: PRIOR_SID,
            logPath: '/tmp/codex-session.jsonl',
          },
        },
      })
      f.spawned[0].emitExit(0)
      expect(await promise).toBe('failed')
      await orch.stop('failed')
    } finally {
      locateSpy.mockRestore()
    }
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
    const inv = defaultPlaywrightSpawner({ feature: f, paths: buildRunPaths(runDir) })
    expect(inv.command).toContain('--max-failures=3')
  })

  it('omits --max-failures when threshold is unset', async () => {
    const { defaultPlaywrightSpawner } = await import('./orchestrator')
    const f = makeFeature()
    const inv = defaultPlaywrightSpawner({ feature: f, paths: buildRunPaths(runDir) })
    expect(inv.command).not.toContain('--max-failures=')
  })

  it('keeps --max-failures on reruns when threshold is set', async () => {
    const { defaultPlaywrightSpawner } = await import('./orchestrator')
    const f = makeFeature({ healOnFailureThreshold: 5 })
    const inv = defaultPlaywrightSpawner({
      feature: f,
      paths: buildRunPaths(runDir),
      rerunTargets: ['e2e/a.spec.ts:10'],
    })
    expect(inv.command).toContain('--max-failures=5')
    expect(inv.command).toContain(JSON.stringify('e2e/a.spec.ts:10'))
  })

  it('supports grep-based rerun selectors for factory-generated tests', async () => {
    const { defaultPlaywrightSpawner } = await import('./orchestrator')
    const f = makeFeature({ healOnFailureThreshold: 2 })
    const inv = defaultPlaywrightSpawner({
      feature: f,
      paths: buildRunPaths(runDir),
      rerunGrep: 'en_SG: checkout',
    })
    expect(inv.command).toContain(`--grep=${JSON.stringify('en_SG: checkout')}`)
    expect(inv.command).toContain('--max-failures=2')
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
    await vi.advanceTimersByTimeAsync(30)
    vi.useRealTimers()

    await orch.stop('passed')

    expect(eventLog[0]).toBe('service-started')
    expect(eventLog).toContain('service-output')
    expect(eventLog.at(-1)).toBe('run-complete')
    expect(fs.existsSync(orch.paths.manifestPath)).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'svc-api.log'))).toBe(true)
  })
})
