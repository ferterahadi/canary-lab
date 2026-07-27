import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator, type ServiceSpec } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor } from './run-paths'
import { readManifest, readRunsIndex } from './manifest'

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
    // No autoHeal / manualHeal / externalHeal configured — healMode falls
    // through the whole ternary chain to undefined.
    expect(manifest.healMode).toBeUndefined()

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

  it('records a boot failure (does NOT throw or abort) on health-check timeout for a normal run', async () => {
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
    // start() no longer rejects — a dead service is a heal-able failure, not an
    // abort. runFullCycle reads the recorded bootFailure and routes to heal.
    await expect(orch.start()).resolves.toBeUndefined()
    expect(checks.at(-1)).toBe(false)
    const manifest = readManifest(orch.paths.manifestPath)!
    expect(manifest.services[0].status).toBe('timeout')
    expect(manifest.bootFailure).toMatchObject({
      service: 'api',
      safeName: 'api',
      reason: 'health-timeout',
    })
    // Lifecycle is an error under starting-services — NOT an 'aborted' phase.
    expect(manifest.lifecycle).toMatchObject({
      phase: 'starting-services',
      headline: 'Service failed to start: api',
    })
    await orch.stop('failed')
  })

  it('fast-fails the health wait when a service process exits before becoming healthy', async () => {
    const { factory, spawned } = makeFakeFactory()
    let calls = 0
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      // Service never gets healthy; the process dies on the first probe. With a
      // long deadline, only the process-exit fast path lets start() resolve.
      healthCheck: async () => {
        calls += 1
        if (calls === 1) spawned[0].emitExit(1)
        return false
      },
      delay: async () => undefined,
      healthDeadlineMs: 60_000,
      healthPollIntervalMs: 1,
    })
    await expect(orch.start()).resolves.toBeUndefined()
    expect(readManifest(orch.paths.manifestPath)?.bootFailure).toMatchObject({
      service: 'api',
      reason: 'process-exited',
    })
    await orch.stop('failed')
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
