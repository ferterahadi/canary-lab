import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import { PortifyRunStore } from './logic/runtime/store'
import { portifyDir } from './logic/runtime/paths'
import { portifyRoutes } from './routes/portify'
import { portifyStreamRoutes } from './ws/portify-stream'
import type { PtyFactory } from '../runs/logic/runtime/pty-spawner'
import type { WorkspaceEventPublisher } from '../../shared/workspace-events'
import type { ServerContext } from '../../server-context'
import { register } from './index'

/**
 * `pickAvailableHealAgent` probes PATH for the `claude` / `codex` binaries — the
 * one dep here a unit test cannot reproduce, and the reason the registrar wraps
 * it at all (so a portify run pins its own agent instead of following the global
 * heal-agent setting). Recording the request proves the preference travels.
 */
const probe = vi.hoisted(() => ({ asked: [] as (string | undefined)[], answer: 'codex' as string | null }))

vi.mock('../runs/logic/runtime/auto-heal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runs/logic/runtime/auto-heal')>()),
  pickAvailableHealAgent: (requested?: string) => {
    probe.asked.push(requested)
    return probe.answer
  },
}))

/**
 * The runner is this feature's agent-spawning edge and has its own six
 * `runner.*.test.ts` suites. It stays real here — a stub would not reject a
 * malformed deps object — and is only observed, because the three callbacks the
 * registrar builds for it (`loadFeatures`, `pickAgent`, `now`) are handed in and
 * are otherwise unreachable.
 */
const runnerBuild = vi.hoisted(() => ({ deps: [] as Record<string, unknown>[] }))

vi.mock('./logic/runtime/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logic/runtime/runner')>()
  return {
    ...actual,
    createPortifyRunner: (deps: Record<string, unknown>) => {
      runnerBuild.deps.push(deps)
      return actual.createPortifyRunner(deps as unknown as Parameters<typeof actual.createPortifyRunner>[0])
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

/**
 * Module-scope so the registration can be identity-checked. `workspaceEvents`
 * is OPTIONAL in `PortifyRouteDeps` and `publishWorkspaceEvent` is
 * `publisher?.publish(...)`, so a registrar that stops passing it still
 * compiles, still boots, and silently stops pushing `features-changed` — the
 * user just sees a stale screen until they refresh (the `cl_ws-driven-state`
 * bug class; the 1.4.0 portify-save gap was exactly this). Only an identity
 * assertion catches that, since `toMatchObject` lets the omission through.
 */
const workspaceEvents: WorkspaceEventPublisher = {
  publish: () => { /* nothing subscribes in this suite */ },
}

let tmpDir: string
let logsDir: string
let featuresDir: string
let portifyStore: PortifyRunStore
let app: FastifyInstance

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-portify-reg-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
  portifyStore = new PortifyRunStore(logsDir)
  probe.asked = []
  probe.answer = 'codex'
  runnerBuild.deps = []
  app = Fastify()
  // The portify stream declares a `{ websocket: true }` route.
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
    portifyStore,
    ptyFactory: inertPtyFactory,
    workspaceEvents,
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
  const spy = vi.spyOn(app, 'register')
  const feature = await register(app, makeCtx())
  const registrations = spy.mock.calls.map((call) => ({
    plugin: call[0] as unknown,
    opts: (call[1] ?? {}) as Record<string, unknown>,
  }))
  spy.mockRestore()
  return { feature, registrations }
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

describe('portify feature registrar', () => {
  it('builds one runner and hands the same store to the routes and the stream', async () => {
    const { feature, registrations } = await registerFeature()

    expect(registrations.map((r) => r.plugin)).toEqual([portifyRoutes, portifyStreamRoutes])
    expect(registrations[0].opts).toMatchObject({
      store: portifyStore,
      logsDir,
      projectRoot: tmpDir,
      startPortify: feature.runner.startPortify,
      startExternalPortify: feature.runner.startExternalPortify,
      savePortify: feature.runner.save,
      cancelPortify: feature.runner.cancel,
      revisePortify: feature.runner.revise,
      removePortify: feature.runner.remove,
    })
    // The live-update bus, by identity: an omission here is invisible until a
    // user notices the Ports tab only changes after a refresh.
    expect(registrations[0].opts.workspaceEvents).toBe(workspaceEvents)
    expect(registrations[1].opts).toEqual({ store: portifyStore })
    // One runner, and it is the instance the MCP layer is handed — a second
    // would mean two owners of the same store.
    expect(runnerBuild.deps).toHaveLength(1)
    expect(runnerBuild.deps[0]).toMatchObject({ logsDir, store: portifyStore, ptyFactory: inertPtyFactory })

    const res = await app.inject({ method: 'GET', url: '/api/portify' })
    expect(res.statusCode).toBe(200)
  })

  it('reads the workspace suites and the chosen agent through the runner\'s callbacks', async () => {
    await registerFeature()
    const deps = runnerBuild.deps[0]
    const load = deps.loadFeatures as () => { name: string }[]

    // Re-read per call, not captured at boot: a suite added after the server
    // started must be portifiable without a restart.
    expect(load()).toEqual([])
    writeFeature('checkout')
    expect(load().map((f) => f.name)).toEqual(['checkout'])

    expect((deps.pickAgent as (p?: string) => string | null)('claude')).toBe('codex')
    expect(probe.asked).toEqual(['claude'])

    expect((deps.now as () => string)()).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('serves a workflow\'s agent transcript only once a session ref exists', async () => {
    const { registrations } = await registerFeature()
    const loadAgentSession = registrations[0].opts.loadAgentSession as
      (id: string) => { agent: string; sessionId: string; events: unknown[] } | null

    // No ref file yet (the agent has not been spawned, or the workflow is
    // external): the route must answer "nothing to show", not throw.
    expect(loadAgentSession('pf_1')).toBeNull()

    const dir = portifyDir(logsDir, 'pf_1')
    fs.mkdirSync(dir, { recursive: true })
    const logPath = path.join(dir, 'claude-session.jsonl')
    fs.writeFileSync(logPath, `${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-21T00:00:00.000Z',
      message: { content: [{ type: 'text', text: 'injecting ports' }] },
    })}\n`)
    fs.writeFileSync(
      path.join(dir, 'agent-session.json'),
      JSON.stringify({ agent: 'claude', sessionId: 'sess-pf1', logPath }),
    )

    const session = loadAgentSession('pf_1')
    expect(session).toMatchObject({ agent: 'claude', sessionId: 'sess-pf1' })
    expect(session?.events).toHaveLength(1)
  })
})
