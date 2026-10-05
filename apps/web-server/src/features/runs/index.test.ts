import { WorkspaceEventBus } from '../../shared/workspace-events'
import { workspaceStreamRoutes } from '../../shared/ws/workspace-stream'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import { PaneBroker } from './logic/pane-broker'
import { ExternalHealBroker } from './logic/heal/external-heal-broker'
import { RunStore } from './logic/run-store'
import { createRegistry, type OrchestratorRegistry } from './logic/run-registry'
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
let externalHealBroker: ExternalHealBroker
let workspaceEvents: WorkspaceEventBus
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
  // A real broker, not a marker: it holds its claims in memory, so the only
  // thing that makes the REST surface, the run-stream wiring and the MCP layer
  // agree about who holds heal duty is that all three were handed THIS
  // instance. Identity is therefore the property under test — a second
  // `new ExternalHealBroker(...)` reads and writes the same manifests while
  // seeing none of the other's claims.
  externalHealBroker = new ExternalHealBroker({
    now: () => Date.now(),
    emit: (event) => runStore.emit('event', event),
    patchManifest: (runId, patch) => runStore.patchManifest(runId, patch),
    audit: () => {},
  })
  workspaceEvents = new WorkspaceEventBus()
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
 * pass `benchmarkStore` and `gettingStarted` straight through into closures no
 * test here invokes, so those two stay markers — the fixture stays honest about
 * what this file depends on. `externalHealBroker` is the exception: this file
 * hands it to `externalHealRoutes` directly, so it is a real instance and gets
 * identity-checked below.
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
    workspaceEvents,
    externalHealBroker,
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
    expect(registrations[0].opts).toEqual({ logsDir, journalPath, runArtifactObserver: registrations[2].opts.runArtifactObserver })
    expect(registrations[0].opts.runArtifactObserver).toMatchObject({ observe: expect.any(Function), dispose: expect.any(Function) })
    expect(registrations[1].opts).toMatchObject({ store: runStore })
    // `toBe`, not a shape match: two brokers over the same run store are
    // structurally identical and behaviourally split.
    expect(registrations[1].opts.broker).toBe(externalHealBroker)
    expect(registrations[2].opts).toMatchObject({ featuresDir, projectRoot: tmpDir, store: runStore })
    expect(registrations[3].opts).toMatchObject({ registry, logsDir })
    expect(registrations[4].opts).toEqual({ store: runStore, featuresDir })

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

it('delivers external completed-run edits through the registered sockets and stops on close', async () => {
  await registerFeature()
  await app.register(workspaceStreamRoutes, { events: workspaceEvents })
  runStore.bootstrap({ runId: 'viewed', feature: 'fixture', startedAt: '2026-01-01T00:00:00Z', status: 'passed', healCycles: 1, services: [] })
  await app.ready()
  const runSocket = await app.injectWS('/ws/runs')
  const workspaceSocket = await app.injectWS('/ws/workspace')
  const runFrames: { type: string; detail?: { lifecycleEvents: { headline: string }[]; manifest: { status: string } } }[] = []
  const journalFrames: { type: string; runId: string }[] = []
  runSocket.on('message', raw => runFrames.push(JSON.parse(String(raw))))
  workspaceSocket.on('message', raw => journalFrames.push(JSON.parse(String(raw))))
  const dir = path.join(logsDir, 'runs', 'viewed')
  try {
    expect((await app.inject('/api/runs/viewed')).statusCode).toBe(200)
    expect((await app.inject('/api/journal?run=viewed')).statusCode).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 50))
    const line = JSON.stringify({ id: 'external', phase: 'completed', headline: 'External lifecycle edit', updatedAt: '2026-01-01T00:01:00Z' })
    fs.writeFileSync(path.join(dir, 'lifecycle-events.jsonl'), `${line}\n{"incomplete":`)
    fs.writeFileSync(path.join(dir, 'diagnosis-journal.md'), '## Iteration 1\n- hypothesis: external journal\n')
    await vi.waitFor(() => {
      expect(runFrames.some(frame => frame.detail?.lifecycleEvents.some(event => event.headline === 'External lifecycle edit'))).toBe(true)
      expect(journalFrames).toContainEqual({ type: 'journal-changed', runId: 'viewed' })
    }, { timeout: 2000 })
    const previous = runFrames.length
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{')
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(runFrames).toHaveLength(previous)
    expect((await app.inject('/api/runs/viewed')).statusCode).toBe(404)
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId: 'viewed', feature: 'fixture', status: 'failed', services: [], healCycles: 1 }))
    await vi.waitFor(() => expect(runFrames.at(-1)?.detail?.manifest.status).toBe('failed'), { timeout: 2000 })
    const count = journalFrames.length
    fs.appendFileSync(path.join(dir, 'diagnosis-journal.md'), '\nstore writer')
    runStore.recordJournalChange('viewed')
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(journalFrames).toHaveLength(count + 1)
  } finally { runSocket.terminate(); workspaceSocket.terminate() }
  await app.close()
  const count = journalFrames.length
  fs.appendFileSync(path.join(dir, 'diagnosis-journal.md'), '\nafter close')
  await new Promise(resolve => setTimeout(resolve, 350))
  expect(journalFrames).toHaveLength(count)
})

it('keeps detail reads usable and logs watcher failure through the registered server', async () => {
  await registerFeature()
  runStore.bootstrap({ runId: 'watch-failed', feature: 'fixture', startedAt: '2026-01-01T00:00:00Z', status: 'passed', healCycles: 0, services: [] })
  const error = new Error('watch unavailable')
  const watch = vi.spyOn(fs, 'watch').mockImplementation(() => { throw error })
  const warning = vi.spyOn(app.log, 'warn')
  try {
    expect((await app.inject('/api/runs/watch-failed')).statusCode).toBe(200)
    expect(warning).toHaveBeenCalledWith({ err: error }, 'Run artifact observation failed; reads will retry')
    expect((await app.inject('/api/runs/watch-failed')).statusCode).toBe(200)
    expect(watch).toHaveBeenCalledTimes(2)
  } finally { watch.mockRestore(); warning.mockRestore() }
})
