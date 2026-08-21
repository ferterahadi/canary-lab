import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import { BenchmarkRunStore } from './logic/runtime/store'
import { benchmarkDir } from './logic/runtime/paths'
import { benchmarkRoutes } from './routes/benchmarks'
import { benchmarkStreamRoutes } from './ws/benchmark-stream'
import { createRegistry, RunStore, type OrchestratorRegistry } from '../runs/logic/run-store'
import type { RunsFeature } from '../runs/index'
import type { PtyFactory } from '../runs/logic/runtime/pty-spawner'
import type { ServerContext } from '../../server-context'
import { register } from './index'

/**
 * `pickAvailableHealAgent` probes PATH for the `claude` / `codex` binaries — the
 * one dep a unit test cannot reproduce. It is also the reason the registrar
 * wraps it: a benchmark pins its own per-run agent instead of following the
 * project's global heal-agent setting, so recording the request is the proof
 * that the caller's preference is what travels.
 */
const probe = vi.hoisted(() => ({ asked: [] as (string | undefined)[], answer: 'claude' as string | null }))

vi.mock('../runs/logic/runtime/auto-heal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runs/logic/runtime/auto-heal')>()),
  pickAvailableHealAgent: (requested?: string) => {
    probe.asked.push(requested)
    return probe.answer
  },
}))

/**
 * The runner races two repair arms — real runs, real agent PTYs — and has its
 * own `runner.*.test.ts` suites. It stays real here so a malformed deps object
 * still fails, and is only observed: the three callbacks the registrar builds
 * for it (`loadFeatures`, `pickAgent`, `now`) are handed in and unreachable
 * from the outside.
 */
const runnerBuild = vi.hoisted(() => ({ deps: [] as Record<string, unknown>[] }))

vi.mock('./logic/runtime/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logic/runtime/runner')>()
  return {
    ...actual,
    createBenchmarkRunner: (deps: Record<string, unknown>) => {
      runnerBuild.deps.push(deps)
      return actual.createBenchmarkRunner(deps as unknown as Parameters<typeof actual.createBenchmarkRunner>[0])
    },
  }
})

const inertPtyFactory: PtyFactory = () => ({
  pid: 0,
  onData: () => ({ dispose: () => { /* noop */ } }),
  onExit: () => ({ dispose: () => { /* noop */ } }),
  write: () => { /* noop */ },
  resize: () => { /* noop */ },
  kill: () => { /* noop */ },
})

let tmpDir: string
let logsDir: string
let featuresDir: string
let registry: OrchestratorRegistry
let runStore: RunStore
let benchmarkStore: BenchmarkRunStore
let runs: RunsFeature
let attached: number
let app: FastifyInstance

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-bench-reg-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
  registry = createRegistry()
  runStore = new RunStore(logsDir, registry)
  benchmarkStore = new BenchmarkRunStore(logsDir)
  attached = 0
  probe.asked = []
  probe.answer = 'claude'
  runnerBuild.deps = []
  // The runs handle benchmark closes over. The scheduler and stream attacher
  // must be the ones the run loop already built — a benchmark arm IS a run.
  runs = {
    scheduler: { fits: () => ({ ok: true }) },
    attachRunStreams: () => { attached += 1 },
    restartExternalRun: () => Promise.reject(new Error('unused by benchmark')),
  } as unknown as RunsFeature
  app = Fastify()
  // The benchmark stream declares a `{ websocket: true }` route.
  await app.register(websocketPlugin)
})

afterEach(async () => {
  await app.close()
})

function makeCtx(): ServerContext {
  return {
    projectRoot: tmpDir,
    featuresDir,
    logsDir,
    registry,
    runStore,
    benchmarkStore,
    ptyFactory: inertPtyFactory,
  } as unknown as ServerContext
}

interface Registration {
  plugin: unknown
  opts: Record<string, unknown>
}

async function registerFeature(): Promise<Registration[]> {
  const spy = vi.spyOn(app, 'register')
  await register(app, makeCtx(), runs)
  const registrations = spy.mock.calls.map((call) => ({
    plugin: call[0] as unknown,
    opts: (call[1] ?? {}) as Record<string, unknown>,
  }))
  spy.mockRestore()
  return registrations
}

/** A real on-disk feature config — `loadFeatures` requires and re-reads it. */
function writeFeature(name: string): void {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', featureDir: __dirname } }`,
  )
}

describe('benchmark feature registrar', () => {
  it('builds the runner over the run loop\'s own primitives and mounts both surfaces', async () => {
    const registrations = await registerFeature()

    expect(registrations.map((r) => r.plugin)).toEqual([benchmarkRoutes, benchmarkStreamRoutes])
    expect(registrations[0].opts).toMatchObject({
      store: benchmarkStore,
      logsDir,
      featuresDir,
      projectRoot: tmpDir,
    })
    expect(registrations[1].opts).toEqual({ store: benchmarkStore })

    // An arm is a real run, so the runner must be handed the shared registry,
    // run store, scheduler and stream attacher — not private copies.
    expect(runnerBuild.deps).toHaveLength(1)
    expect(runnerBuild.deps[0]).toMatchObject({
      projectRoot: tmpDir,
      logsDir,
      store: benchmarkStore,
      ptyFactory: inertPtyFactory,
      runStore,
      registry,
      scheduler: runs.scheduler,
    })
    ;(runnerBuild.deps[0].attachRunStreams as () => void)()
    expect(attached).toBe(1)

    const res = await app.inject({ method: 'GET', url: '/api/benchmarks' })
    expect(res.statusCode).toBe(200)
  })

  it('reads the workspace suites and the pinned agent through the runner\'s callbacks', async () => {
    await registerFeature()
    const deps = runnerBuild.deps[0]
    const load = deps.loadFeatures as () => { name: string }[]

    // Re-read per call, not captured at boot: a suite added after the server
    // started must be benchmarkable without a restart.
    expect(load()).toEqual([])
    writeFeature('demo_catalog')
    expect(load().map((f) => f.name)).toEqual(['demo_catalog'])

    expect((deps.pickAgent as (p?: string) => string | null)('codex')).toBe('claude')
    expect(probe.asked).toEqual(['codex'])

    expect((deps.now as () => string)()).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('lists the bundled sabotage skills that apply to a suite', async () => {
    const registrations = await registerFeature()
    const listSkills = registrations[0].opts.listSkills as (feature: string) => { name: string }[]

    // The shipped skills all declare `appliesTo: ['*']`, so every suite sees
    // the full set — the picker being empty would mean the bundled prompts
    // failed to resolve from this module's path depth.
    expect(listSkills('demo_catalog').map((s) => s.name).sort())
      .toEqual(['broken-delete-contract', 'multi-failure-cascade', 'off-by-one'])
  })

  it('serves a benchmark\'s sabotage transcript only once a session ref exists', async () => {
    const registrations = await registerFeature()
    const loadAgentSession = registrations[0].opts.loadAgentSession as
      (id: string) => { agent: string; sessionId: string; events: unknown[] } | null

    // No ref file yet (sabotage has not spawned): the route must answer
    // "nothing to show", not throw.
    expect(loadAgentSession('bm_1')).toBeNull()

    const dir = benchmarkDir(logsDir, 'bm_1')
    fs.mkdirSync(dir, { recursive: true })
    const logPath = path.join(dir, 'claude-session.jsonl')
    fs.writeFileSync(logPath, `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-21T00:00:00.000Z',
      message: { content: [{ type: 'text', text: 'planting the bug' }] },
    })}\n`)
    fs.writeFileSync(
      path.join(dir, 'agent-session.json'),
      JSON.stringify({ agent: 'claude', sessionId: 'sess-bm1', logPath }),
    )

    const session = loadAgentSession('bm_1')
    expect(session).toMatchObject({ agent: 'claude', sessionId: 'sess-bm1' })
    expect(session?.events).toHaveLength(1)
  })
})
