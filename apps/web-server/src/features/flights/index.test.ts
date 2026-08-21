import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import { FlightRunStore } from './logic/store'
import { PlanFeaturesStore } from './logic/plan-features'
import { flightsRoutes } from './routes/flights'
import { flightsStreamRoutes } from './ws/flights-stream'
import type { FlightInject } from './logic/stages/index'
import type { WorkspaceEventPublisher } from '../../shared/workspace-events'
import type { GettingStartedSessionStore } from '../config/logic/getting-started-session'
import type { ServerContext } from '../../server-context'
import { register } from './index'

/**
 * The stage adapters are the flight's heaviest subsystem — each one spawns
 * agents and drives whole runs, and each has its own `stages.*.test.ts` suite.
 * Here the builder stays real (so a deps object it would reject is still a
 * failure) and is only observed, because the `inject` bridge the registrar
 * builds is handed *into* it and is otherwise unreachable from the outside.
 */
const stageBuild = vi.hoisted(() => ({ deps: [] as Record<string, unknown>[] }))

vi.mock('./logic/stages/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logic/stages/index')>()
  return {
    ...actual,
    buildFlightStageAdapters: (deps: Record<string, unknown>) => {
      stageBuild.deps.push(deps)
      return actual.buildFlightStageAdapters(deps as unknown as Parameters<typeof actual.buildFlightStageAdapters>[0])
    },
  }
})

/**
 * Both of these are module-scope for one reason: they can only be checked by
 * IDENTITY, and both are OPTIONAL on `FlightRouteDeps`, so dropping either from
 * the registration compiles and boots.
 *
 * `workspaceEvents` — `publishWorkspaceEvent` is `publisher?.publish(...)`, so
 * an absent bus silently stops every `flights-changed` / `coverage-changed` /
 * `envsets-changed` push the routes and the stage adapters make: the user just
 * sees a flight that only moves when they refresh (the `cl_ws-driven-state` bug
 * class).
 *
 * `gettingStarted` — `flights-start.ts` guards on `body.gettingStartedSource &&
 * deps.gettingStarted`, so an absent store makes the demo's claim/attach/abandon
 * a no-op and the `getting_started_busy` protection disappear, with no error
 * anywhere. A marker object is enough: nothing in this suite calls it.
 */
const workspaceEvents: WorkspaceEventPublisher = {
  publish: () => { /* nothing subscribes in this suite */ },
}
const gettingStarted = { marker: 'getting-started' } as unknown as GettingStartedSessionStore

let tmpDir: string
let logsDir: string
let featuresDir: string
let flightStore: FlightRunStore
let planStore: PlanFeaturesStore
let app: FastifyInstance

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flights-reg-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
  flightStore = new FlightRunStore(logsDir)
  planStore = new PlanFeaturesStore(logsDir)
  stageBuild.deps = []
  app = Fastify()
  // The flights stream declares a `{ websocket: true }` route.
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
    flightStore,
    planStore,
    workspaceEvents,
    gettingStarted,
  } as unknown as ServerContext
}

interface Registration {
  plugin: unknown
  opts: Record<string, unknown>
}

async function registerFeature(): Promise<Registration[]> {
  const spy = vi.spyOn(app, 'register')
  await register(app, makeCtx())
  const registrations = spy.mock.calls.map((call) => ({
    plugin: call[0] as unknown,
    opts: (call[1] ?? {}) as Record<string, unknown>,
  }))
  spy.mockRestore()
  return registrations
}

describe('flights feature registrar', () => {
  it('mounts the REST surface then the push channel over the one shared store', async () => {
    const registrations = await registerFeature()

    expect(registrations.map((r) => r.plugin)).toEqual([flightsRoutes, flightsStreamRoutes])
    expect(registrations[0].opts).toMatchObject({
      featuresDir,
      logsDir,
      projectRoot: tmpDir,
      flightStore,
      planStore,
    })
    // Both surfaces must read the same store instance, or the stream would
    // report a manifest the REST routes never wrote.
    expect(registrations[1].opts).toEqual({ store: flightStore })
    // The two optional deps, by identity — see the fixture comment for what
    // each one silently costs when it stops being passed.
    expect(registrations[0].opts.workspaceEvents).toBe(workspaceEvents)
    expect(registrations[0].opts.gettingStarted).toBe(gettingStarted)
    expect(Object.keys(registrations[0].opts.adapters as object)).toContain('evaluation-export')
    // One adapter set, built with the resolved paths the registrar was given
    // rather than any re-derived from projectRoot.
    expect(stageBuild.deps).toHaveLength(1)
    expect(stageBuild.deps[0]).toMatchObject({ featuresDir, logsDir, projectRoot: tmpDir })
    // The adapters need the SAME bus: a stage that writes a doc or captures an
    // envset announces it through here, not through the route layer's copy.
    expect(stageBuild.deps[0].workspaceEvents).toBe(workspaceEvents)

    const res = await app.inject({ method: 'GET', url: '/api/flights' })
    expect(res.statusCode).toBe(200)
  })

  it('gives the stage adapters an inject bridge into this same app\'s routes', async () => {
    await registerFeature()
    const inject = stageBuild.deps[0].inject as FlightInject

    // A payload-less stage call reaches the flights read route it would in
    // production — the bridge is the app's own routing table, not a fresh one.
    const listed = await inject({ method: 'GET', url: '/api/flights' })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({ flights: [] })

    // With a payload the body has to survive the hop, or every stage that POSTs
    // would silently act on an empty request: `remedy` answers 400 on a missing
    // action and 404 once the action parsed, so the 404 is the proof.
    const posted = await inject({
      method: 'POST',
      url: '/api/flights/ghost/remedy',
      payload: { action: 'stash' },
    })
    expect(posted.statusCode).toBe(404)
    expect(posted.json()).toEqual({ error: 'flight not found: ghost' })
  })
})
