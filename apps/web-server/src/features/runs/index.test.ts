import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import { PaneBroker } from './logic/pane-broker'
import { RunStore, createRegistry, type OrchestratorRegistry } from './logic/run-store'
import { DirtySpecStore } from './logic/dirty-specs/store'
import type { PtyFactory } from './logic/runtime/pty-spawner'
import type { BackupRecord } from './logic/runtime/env-switcher/types'
import type { ServerContext } from '../../server-context'
import { journalRoutes } from './routes/journal'
import { runsRoutes } from './routes/runs'
import { externalHealRoutes } from './routes/external-heal'
import { paneStreamRoutes } from './ws/pane-stream'
import { runsStreamRoutes } from './ws/runs-stream'
import { register } from './index'

/**
 * The registrar's job is wiring, so every route plugin here is the real one —
 * a stub would prove only that the stub was registered, and a deps object that
 * the real plugin would reject at boot is exactly the regression this suite
 * exists to catch. `register` is spied purely to read back the deps object each
 * plugin received; the spy calls through.
 */
let tmpDir: string
let logsDir: string
let featuresDir: string
let journalPath: string
let registry: OrchestratorRegistry
let runStore: RunStore
let brokers: Map<string, PaneBroker>
let activeEnvsets: Map<string, BackupRecord[]>
let app: FastifyInstance

const inertPtyFactory: PtyFactory = () => ({
  pid: 0,
  onData: () => ({ dispose: () => { /* noop */ } }),
  onExit: () => ({ dispose: () => { /* noop */ } }),
  write: () => { /* noop */ },
  resize: () => { /* noop */ },
  kill: () => { /* noop */ },
})

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-runs-reg-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  journalPath = path.join(tmpDir, 'journal.jsonl')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
  registry = createRegistry()
  runStore = new RunStore(logsDir, registry)
  brokers = new Map()
  activeEnvsets = new Map()
  app = Fastify()
  // The pane and run streams declare `{ websocket: true }` routes, which is an
  // option @fastify/websocket adds. Without the plugin the registrar's last two
  // registrations would fail here for a reason production never sees.
  await app.register(websocketPlugin)
})

afterEach(async () => {
  await app.close()
})

/**
 * `register` destructures the whole context but reads only these members; the
 * factories it calls (`buildRunScheduling`, `buildRunsRouteDeps`) additionally
 * pass `benchmarkStore`, `externalHealBroker` and `gettingStarted` straight
 * through into closures no test here invokes, so those are markers rather than
 * real stores — the fixture stays honest about what this file depends on.
 */
function makeCtx(): ServerContext {
  return {
    options: {},
    projectRoot: tmpDir,
    featuresDir,
    logsDir,
    journalPath,
    registry,
    runStore,
    benchmarkStore: { marker: 'benchmark-store' },
    dirtySpecStore: new DirtySpecStore(logsDir),
    workspaceEvents: { publish: () => { /* nothing subscribes in this suite */ } },
    externalHealBroker: { marker: 'external-heal-broker' },
    gettingStarted: { marker: 'getting-started' },
    brokers,
    activeEnvsets,
    ptyFactory: inertPtyFactory,
  } as unknown as ServerContext
}

interface Registration {
  plugin: unknown
  opts: Record<string, unknown>
}

async function registerFeature(): Promise<{
  feature: Awaited<ReturnType<typeof register>>
  registrations: Registration[]
}> {
  const registrations: Registration[] = []
  const spy = vi.spyOn(app, 'register')
  const feature = await register(app, makeCtx())
  for (const call of spy.mock.calls) {
    registrations.push({ plugin: call[0], opts: (call[1] ?? {}) as Record<string, unknown> })
  }
  spy.mockRestore()
  return { feature, registrations }
}

describe('runs feature registrar', () => {
  it('mounts the run loop\'s five plugins with the deps each one needs', async () => {
    const { feature, registrations } = await registerFeature()

    expect(registrations.map((r) => r.plugin)).toEqual([
      journalRoutes,
      externalHealRoutes,
      runsRoutes,
      paneStreamRoutes,
      runsStreamRoutes,
    ])
    expect(registrations[0].opts).toEqual({ logsDir, journalPath })
    expect(registrations[1].opts).toMatchObject({ store: runStore })
    expect(registrations[2].opts).toMatchObject({ featuresDir, projectRoot: tmpDir, store: runStore })
    expect(registrations[3].opts).toMatchObject({ registry, logsDir })
    expect(registrations[4].opts).toEqual({ store: runStore })

    // The handle benchmark and the MCP surface reuse. An empty queue plus a
    // usable `fits` is the scheduler having been constructed here rather than
    // left for a second owner to build.
    expect(feature.scheduler.queued()).toEqual([])
    expect(feature.scheduler.fits({ repoPaths: [], cost: 0 })).toEqual({ ok: true })
    expect(feature.attachRunStreams).toBeTypeOf('function')
    expect(feature.restartExternalRun).toBeTypeOf('function')
    expect(registrations[2].opts.restartHeal).toBeTypeOf('function')

    // The routes really mounted: a request reaches a handler rather than a 404.
    const res = await app.inject({ method: 'GET', url: '/api/runs' })
    expect(res.statusCode).toBe(200)
  })

  it('resolves a pane\'s broker only while the run still holds one', async () => {
    const { registrations } = await registerFeature()
    const brokerFor = registrations[3].opts.brokerFor as (runId: string) => PaneBroker | null
    const broker = new PaneBroker()
    brokers.set('r-1', broker)

    expect(brokerFor('r-1')).toBe(broker)
    // A reaped broker must read as "stream the log file instead", not undefined:
    // pane-stream branches on null.
    expect(brokerFor('r-2')).toBeNull()
  })

  it('back-fills the external-heal route\'s local-heal restart after the runs route is up', async () => {
    const { registrations } = await registerFeature()
    const restartLocalHeal = registrations[1].opts.restartLocalHeal as
      (runId: string, guidance: string) => Promise<{ ok: boolean; reason?: string }>

    // Late binding is the point: the closure only exists after runsRoutes was
    // registered, and the external-heal route reads it at request time. Driving
    // it proves the property that was threaded through, not just that a
    // function was assigned.
    expect(restartLocalHeal).toBeTypeOf('function')
    await expect(restartLocalHeal('ghost', 'try again')).resolves.toEqual({
      ok: false,
      reason: 'run-not-found',
    })
  })
})
