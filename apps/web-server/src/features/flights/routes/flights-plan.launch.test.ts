import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

import Fastify, { type FastifyInstance } from 'fastify'

import { flightsRoutes } from './flights'

import { FlightRunStore, type FlightStore, type FlightStoreEvent } from '../logic/store'

import type { StageAdapters } from '../logic/conductor'

import type { FlightAgentSpawner } from '../logic/stages/context'

import { FLIGHT_STAGE_KEYS } from '../logic/types'

import type { FlightIndexEntry, FlightManifest } from '../logic/types'

import type { PlanFeaturesTask, PlannedFeature } from '../../../../../../shared/flights/types'

let tmpDir: string

let repoDir: string

let app: FastifyInstance

function allDone(): StageAdapters {
  return Object.fromEntries(
    FLIGHT_STAGE_KEYS.map((k) => [k, { run: async () => ({ kind: 'done' as const }) }]),
  ) as StageAdapters
}

async function buildApp(
  adapters: StageAdapters,
  flightStore?: FlightStore,
  planAgent?: FlightAgentSpawner,
): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false })
  await instance.register(flightsRoutes, {
    featuresDir: path.join(tmpDir, 'features'),
    logsDir: tmpDir,
    projectRoot: tmpDir,
    adapters,
    ...(flightStore ? { flightStore } : {}),
    ...(planAgent ? { planAgent } : {}),
  })
  return instance
}

/** A store stub whose `save` throws a non-Error value synchronously — used to
 *  exercise startFlight's non-FlightConflictError rethrow path. */
function saveThrowsStore(thrown: unknown): FlightStore {
  return {
    list(): FlightIndexEntry[] {
      return []
    },
    get(): FlightManifest | null {
      return null
    },
    activeForRepos(): FlightIndexEntry | null {
      return null
    },
    latestForRepos(): FlightIndexEntry | null {
      return null
    },
    latestForFeature(): FlightIndexEntry | null {
      return null
    },
    save(): void {
      throw thrown
    },
    remove(): void {},
    renameFeature(): number {
      return 0
    },
    flightDir(flightId: string): string {
      return path.join(tmpDir, 'flights', flightId)
    },
    reconcileInterrupted(): void {},
    onEvent(_fn: (event: FlightStoreEvent) => void): void {},
    offEvent(_fn: (event: FlightStoreEvent) => void): void {},
  }
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-routes-')))
  repoDir = path.join(tmpDir, 'product-repo')
  fs.mkdirSync(repoDir, { recursive: true })
})

afterEach(async () => {
  await app?.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const startBody = (over: Record<string, unknown> = {}) => ({
  feature: 'checkout',
  repoPaths: [repoDir],
  description: 'checkout flow',
  ...over,
})

const planText = (features: unknown) => `\`\`\`json\n${JSON.stringify({ split: Array.isArray(features) && (features as unknown[]).length > 1, features })}\n\`\`\``

const agentReturning = (text: string | (() => string)): FlightAgentSpawner => async () => ({
  text: typeof text === 'function' ? text() : text,
})

async function waitForStatus(flightId: string, statuses: string[], timeoutMs = 3000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const resp = await app.inject({ method: 'GET', url: `/api/flights/${flightId}` })
    const manifest = resp.json() as Record<string, unknown>
    if (statuses.includes(String(manifest.status))) return manifest
    if (Date.now() > deadline) throw new Error(`flight never reached ${statuses.join('/')}: ${String(manifest.status)}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('plan-features (R54)', () => {
  async function planAndWait(instance: FastifyInstance, body?: Record<string, unknown>): Promise<PlanFeaturesTask> {
    const res = await instance.inject({
      method: 'POST',
      url: '/api/flights/plan-features',
      body: { repoPaths: [repoDir], description: 'test everything in this repo', ...body },
    })
    expect(res.statusCode).toBe(202)
    const { taskId } = res.json() as { taskId: string }
    const deadline = Date.now() + 3000
    for (;;) {
      const poll = await instance.inject({ method: 'GET', url: `/api/flights/plan-features/${taskId}` })
      const task = poll.json() as PlanFeaturesTask
      if (task.status !== 'running') return task
      if (Date.now() > deadline) throw new Error('plan task never settled')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('launch creates one running flight + queued siblings that drain sequentially', async () => {
    app = await buildApp(allDone(), undefined, agentReturning(planText([
      { name: 'one', description: 'test one' },
      { name: 'two', description: 'test two' },
      { name: 'three', description: 'test three' },
    ])))
    const task = await planAndWait(app)
    const launched = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features },
    })
    expect(launched.statusCode).toBe(201)
    const { flightIds } = launched.json() as { flightIds: string[] }
    expect(flightIds).toHaveLength(3)
    // Stub adapters settle instantly, so the drain chain runs the whole batch.
    const deadline = Date.now() + 3000
    for (;;) {
      const list = await app.inject({ method: 'GET', url: '/api/flights' })
      const flights = (list.json() as { flights: Array<{ status: string; opts?: unknown }> }).flights
      if (flights.length === 3 && flights.every((f) => f.status === 'done')) break
      if (Date.now() > deadline) throw new Error(`batch never drained: ${JSON.stringify(flights)}`)
      await new Promise((r) => setTimeout(r, 10))
    }
    // A second launch must not double-create the batch.
    const again = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features },
    })
    expect(again.statusCode).toBe(409)
  })

  it('launch carries the dialog\'s autopilot + agent choice onto every minted flight', async () => {
    app = await buildApp(allDone(), undefined, agentReturning(planText([
      { name: 'one', description: 'test one' },
      { name: 'two', description: 'test two' },
    ])))
    const task = await planAndWait(app)

    const launched = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features, autopilot: false, agent: 'codex' },
    })

    expect(launched.statusCode).toBe(201)
    const { flightIds } = launched.json() as { flightIds: string[] }
    for (const id of flightIds) {
      const manifest = (await app.inject({ method: 'GET', url: `/api/flights/${id}` })).json() as { opts: { autopilot?: boolean; agent?: string } }
      expect(manifest.opts).toMatchObject({ autopilot: false, agent: 'codex' })
    }
  })

  it('launch inherits the agent from the plan task when the body omits it', async () => {
    // The proposal dialog only re-sends what the user changed, so the task's own
    // agent choice has to be the fallback.
    app = await buildApp(allDone(), undefined, agentReturning(planText([
      { name: 'one', description: 'test one' },
      { name: 'two', description: 'test two' },
    ])))
    const task = await planAndWait(app, { agent: 'codex', autopilot: false })

    const launched = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features },
    })

    expect(launched.statusCode).toBe(201)
    const { flightIds } = launched.json() as { flightIds: string[] }
    const manifest = (await app.inject({ method: 'GET', url: `/api/flights/${flightIds[0]}` })).json() as { opts: { autopilot?: boolean; agent?: string } }
    expect(manifest.opts).toMatchObject({ autopilot: false, agent: 'codex' })
  })

  it('a single-feature proposal auto-launches with the autopilot + agent it was started with', async () => {
    // The auto-launch path builds its own options off the settled task, so the
    // dialog's choices have to survive that hop too (R71/W4).
    app = await buildApp(allDone(), undefined, agentReturning(planText([{ name: 'solo', description: 'test the one thing' }])))

    // A single-feature proposal launches itself, so the task settles straight
    // into `launched` rather than waiting for a confirmation.
    const task = await planAndWait(app, { autopilot: false, agent: 'codex' })
    expect(task.status).toBe('launched')
    expect(task.autopilot).toBe(false)
    expect(task.agent).toBe('codex')

    const deadline = Date.now() + 3000
    for (;;) {
      const flights = ((await app.inject({ method: 'GET', url: '/api/flights' })).json() as { flights: Array<{ flightId: string }> }).flights
      if (flights.length === 1) {
        const manifest = (await app.inject({ method: 'GET', url: `/api/flights/${flights[0].flightId}` })).json() as { opts: { autopilot?: boolean; agent?: string } }
        expect(manifest.opts).toMatchObject({ autopilot: false, agent: 'codex' })
        break
      }
      if (Date.now() > deadline) throw new Error('auto-launch never minted the flight')
      await new Promise((r) => setTimeout(r, 10))
    }
  })

  it('launch answers 409 with wait-for-the-proposal copy while planning is still running', async () => {
    const gateBox: { gate: (() => void) | null } = { gate: null }
    app = await buildApp(allDone(), undefined, async () => {
      await new Promise<void>((resolve) => { gateBox.gate = resolve })
      return { text: planText([{ name: 'one', description: 'test one' }, { name: 'two', description: 'test two' }]) }
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/flights/plan-features',
      body: { repoPaths: [repoDir], description: 'test everything in this repo' },
    })
    expect(res.statusCode).toBe(202)
    const { taskId } = res.json() as { taskId: string }

    const launched = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${taskId}/launch`,
      body: { features: [{ name: 'one', description: 'test one' }] },
    })
    expect(launched.statusCode).toBe(409)
    expect((launched.json() as { error: string }).error).toContain('still running — wait for the proposal')

    // Let the parked agent finish so teardown never races a dangling promise.
    const deadline = Date.now() + 3000
    while (gateBox.gate === null) {
      if (Date.now() > deadline) throw new Error('plan agent never started')
      await new Promise((r) => setTimeout(r, 10))
    }
    gateBox.gate()
    for (;;) {
      const poll = await app.inject({ method: 'GET', url: `/api/flights/plan-features/${taskId}` })
      if ((poll.json() as PlanFeaturesTask).status !== 'running') break
      if (Date.now() > deadline) throw new Error('plan task never settled')
      await new Promise((r) => setTimeout(r, 10))
    }
  })

  it('launch rejects name collisions with existing features/flights up front', async () => {
    app = await buildApp(allDone(), undefined, agentReturning(planText([
      { name: 'checkout', description: 'test checkout' },
      { name: 'fresh-one', description: 'test fresh' },
    ])))
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    await waitForStatus((started.json() as { flightId: string }).flightId, ['done'])
    const task = await planAndWait(app)
    const launched = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features },
    })
    expect(launched.statusCode).toBe(409)
    expect(launched.json()).toMatchObject({ type: 'feature_name_conflicts', conflicts: ['checkout'] })
    // Nothing was created — a partial batch would be worse than the rejection.
    const list = await app.inject({ method: 'GET', url: '/api/flights' })
    expect((list.json() as { flights: Array<{ feature: string }> }).flights.map((f) => f.feature)).toEqual(['checkout'])
  })

  it('launch parks every sibling queued when the repo is already busy with an unrelated active flight', async () => {
    // The repo-name conflict pre-check only looks at FEATURE-name collisions;
    // a repo already flying under a DIFFERENT feature name slips past it and
    // is caught by startFlight's own single-flight guard instead — which
    // executePlannedLaunch swallows (FlightConflictError) and parks queued,
    // rather than rethrowing.
    const gateBox: { gate: (() => void) | null } = { gate: null }
    const busyAdapters = allDone()
    busyAdapters.scout = {
      run: async () => { await new Promise<void>((resolve) => { gateBox.gate = resolve }); return { kind: 'done' as const } },
    }
    app = await buildApp(busyAdapters, undefined, agentReturning(planText([
      { name: 'other-one', description: 'test other one' },
      { name: 'other-two', description: 'test other two' },
    ])))
    const busy = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const busyId = (busy.json() as { flightId: string }).flightId
    const deadline0 = Date.now() + 3000
    while (gateBox.gate === null) {
      if (Date.now() > deadline0) throw new Error('busy flight never started')
      await new Promise((r) => setTimeout(r, 10))
    }

    const task = await planAndWait(app)
    const launched = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features },
    })
    expect(launched.statusCode).toBe(201)
    const { flightIds } = launched.json() as { flightIds: string[] }
    expect(flightIds).toHaveLength(2)
    const list = await app.inject({ method: 'GET', url: '/api/flights' })
    const flights = (list.json() as { flights: Array<{ feature: string; status: string; pauseReason?: string }> }).flights
    expect(flights.find((f) => f.feature === 'other-one')).toMatchObject({ status: 'paused', pauseReason: 'queued' })
    expect(flights.find((f) => f.feature === 'other-two')).toMatchObject({ status: 'paused', pauseReason: 'queued' })

    gateBox.gate!()
    await waitForStatus(busyId, ['done'])
  })

  it('a single-feature plan auto-launches server-side (no proposal, no /launch call)', async () => {
    app = await buildApp(allDone(), undefined, agentReturning(planText([
      { name: 'solo-feature', description: 'test the whole thing' },
    ])))
    const task = await planAndWait(app)
    expect(task.status).toBe('launched')
    expect(task.launchedFlightIds).toHaveLength(1)
    const list = await app.inject({ method: 'GET', url: '/api/flights' })
    expect((list.json() as { flights: Array<{ feature: string }> }).flights.map((f) => f.feature)).toContain('solo-feature')
  })

  it('cancelling a stale planning frame aborts the flight that won the auto-launch race', async () => {
    let releaseScout: (() => void) | null = null
    const adapters = allDone()
    adapters.scout = {
      run: async () => {
        await new Promise<void>((resolve) => { releaseScout = resolve })
        return { kind: 'done' as const }
      },
    }
    app = await buildApp(adapters, undefined, agentReturning(planText([
      { name: 'race-winner', description: 'test the whole thing' },
    ])))
    const task = await planAndWait(app)
    expect(task.status).toBe('launched')
    const flightId = task.launchedFlightIds![0]

    const cancelled = await app.inject({ method: 'POST', url: `/api/flights/plan-features/${task.taskId}/cancel` })
    expect(cancelled.statusCode).toBe(200)
    expect((cancelled.json() as PlanFeaturesTask).status).toBe('cancelled')
    const flight = await app.inject({ method: 'GET', url: `/api/flights/${flightId}` })
    expect((flight.json() as { status: string }).status).toBe('aborted')

    releaseScout!()
  })

  it('cancels every launched descendant without letting a queued sibling start between aborts', async () => {
    let releaseScout: (() => void) | null = null
    const adapters = allDone()
    adapters.scout = {
      run: async () => {
        await new Promise<void>((resolve) => { releaseScout = resolve })
        return { kind: 'done' as const }
      },
    }
    app = await buildApp(adapters, undefined, agentReturning(planText([
      { name: 'batch-one', description: 'test one' },
      { name: 'batch-two', description: 'test two' },
    ])))
    const task = await planAndWait(app)
    const launched = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features },
    })
    const { flightIds } = launched.json() as { flightIds: string[] }
    expect(flightIds).toHaveLength(2)
    const deadline = Date.now() + 3000
    while (releaseScout === null) {
      if (Date.now() > deadline) throw new Error('first descendant never reached scout')
      await new Promise((r) => setTimeout(r, 10))
    }

    const cancelled = await app.inject({ method: 'POST', url: `/api/flights/plan-features/${task.taskId}/cancel` })
    expect(cancelled.statusCode).toBe(200)
    for (const flightId of flightIds) {
      const flight = await app.inject({ method: 'GET', url: `/api/flights/${flightId}` })
      expect((flight.json() as { status: string }).status).toBe('aborted')
    }

    releaseScout!()
  })

  it('cancels a checkpointed descendant before its queued sibling can start', async () => {
    const adapters = allDone()
    adapters.scout = {
      run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'config-approval', message: 'approve?' } }),
    }
    app = await buildApp(adapters, undefined, agentReturning(planText([
      { name: 'checkpointed', description: 'test checkpointed' },
      { name: 'queued', description: 'test queued' },
    ])))
    const task = await planAndWait(app)
    const launched = await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features },
    })
    const { flightIds } = launched.json() as { flightIds: string[] }
    const deadline = Date.now() + 3000
    for (;;) {
      const first = (await app.inject({ method: 'GET', url: `/api/flights/${flightIds[0]}` })).json() as { status: string }
      if (first.status === 'waiting-for-approval') break
      if (Date.now() > deadline) throw new Error('first descendant never reached its checkpoint')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const cancelled = await app.inject({ method: 'POST', url: `/api/flights/plan-features/${task.taskId}/cancel` })
    expect(cancelled.statusCode).toBe(200)
    for (const flightId of flightIds) {
      const flight = await app.inject({ method: 'GET', url: `/api/flights/${flightId}` })
      expect((flight.json() as { status: string }).status).toBe('aborted')
    }
  })

  it('a single-feature plan whose name clashes stays done with the conflict recorded', async () => {
    app = await buildApp(allDone(), undefined, agentReturning(planText([
      { name: 'checkout', description: 'test checkout' },
    ])))
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    await waitForStatus((started.json() as { flightId: string }).flightId, ['done'])
    const task = await planAndWait(app)
    expect(task.status).toBe('done')
    expect(task.conflicts).toEqual(['checkout'])
    expect(task.launchedFlightIds).toBeUndefined()
  })

  describe('launch validation', () => {
    it('404s launch for an unknown task', async () => {
      app = await buildApp(allDone())
      const resp = await app.inject({
        method: 'POST',
        url: '/api/flights/plan-features/fp_nope/launch',
        body: { features: [{ name: 'x', description: 'd' }] },
      })
      expect(resp.statusCode).toBe(404)
      expect(resp.json()).toMatchObject({ error: 'plan task not found: fp_nope' })
    })

    it('400s when features is missing or empty (including an undefined body)', async () => {
      app = await buildApp(allDone(), undefined, agentReturning(planText([
        { name: 'alpha', description: 'test alpha' },
        { name: 'beta', description: 'test beta' },
      ])))
      const task = await planAndWait(app)
      const undefinedBody = await app.inject({
        method: 'POST',
        url: `/api/flights/plan-features/${task.taskId}/launch`,
      })
      expect(undefinedBody.statusCode).toBe(400)
      expect(undefinedBody.json()).toMatchObject({ error: 'features (non-empty array) is required' })

      const missing = await app.inject({
        method: 'POST',
        url: `/api/flights/plan-features/${task.taskId}/launch`,
        body: {},
      })
      expect(missing.statusCode).toBe(400)
      expect(missing.json()).toMatchObject({ error: 'features (non-empty array) is required' })

      const empty = await app.inject({
        method: 'POST',
        url: `/api/flights/plan-features/${task.taskId}/launch`,
        body: { features: [] },
      })
      expect(empty.statusCode).toBe(400)
    })

    it('400s when a feature entry has no derivable slug name (name omitted) or no description', async () => {
      app = await buildApp(allDone(), undefined, agentReturning(planText([
        { name: 'alpha', description: 'test alpha' },
        { name: 'beta', description: 'test beta' },
      ])))
      const task = await planAndWait(app)
      // name key entirely absent (not just empty) — exercises the `f?.name`
      // nullish-coalescing fallback distinct from an explicit empty string.
      const noNameKey = await app.inject({
        method: 'POST',
        url: `/api/flights/plan-features/${task.taskId}/launch`,
        body: { features: [{ description: 'has a description, no name field' }] },
      })
      expect(noNameKey.statusCode).toBe(400)
      expect(noNameKey.json()).toMatchObject({ error: 'Every suite needs a name and a description.' })

      const noName = await app.inject({
        method: 'POST',
        url: `/api/flights/plan-features/${task.taskId}/launch`,
        body: { features: [{ name: '', description: 'has a description' }] },
      })
      expect(noName.statusCode).toBe(400)
      expect(noName.json()).toMatchObject({ error: 'Every suite needs a name and a description.' })

      const noDescription = await app.inject({
        method: 'POST',
        url: `/api/flights/plan-features/${task.taskId}/launch`,
        body: { features: [{ name: 'named-thing' }] },
      })
      expect(noDescription.statusCode).toBe(400)
      expect(noDescription.json()).toMatchObject({ error: 'Every suite needs a name and a description.' })
    })

    it('400s duplicate feature names in the launch body', async () => {
      app = await buildApp(allDone(), undefined, agentReturning(planText([
        { name: 'alpha', description: 'test alpha' },
        { name: 'beta', description: 'test beta' },
      ])))
      const task = await planAndWait(app)
      const resp = await app.inject({
        method: 'POST',
        url: `/api/flights/plan-features/${task.taskId}/launch`,
        body: {
          features: [
            { name: 'dup', description: 'first' },
            { name: 'dup', description: 'second' },
          ],
        },
      })
      expect(resp.statusCode).toBe(400)
      expect(resp.json()).toMatchObject({ error: 'Suite names must be unique.' })
    })

    it('carries a group through to the launched flight opts', async () => {
      app = await buildApp(allDone(), undefined, agentReturning(planText([
        { name: 'alpha', description: 'test alpha' },
        { name: 'beta', description: 'test beta' },
      ])))
      const task = await planAndWait(app)
      const launched = await app.inject({
        method: 'POST',
        url: `/api/flights/plan-features/${task.taskId}/launch`,
        body: { features: [{ name: 'grouped-one', description: 'test grouped', group: 'My Shop' }] },
      })
      expect(launched.statusCode).toBe(201)
      const { flightIds } = launched.json() as { flightIds: string[] }
      const flight = await app.inject({ method: 'GET', url: `/api/flights/${flightIds[0]}` })
      expect((flight.json() as { opts: { group?: string } }).opts.group).toBe('my-shop')
    })
  })

  it('a non-conflict error during single-feature auto-launch leaves the already-settled task alone', async () => {
    // The plan settles `done` before autoLaunch runs; if autoLaunch throws a
    // non-conflict error (executePlannedLaunch rethrows it — flights.ts), the
    // outer catch's settle() call finds the task no longer `running` and
    // refuses to resurrect it (plan-features.ts's "don't overwrite" guard) —
    // so the task stays `done`, not `failed`.
    app = await buildApp(allDone(), saveThrowsStore(new Error('disk broken')), agentReturning(planText([
      { name: 'solo-thing', description: 'test the whole thing' },
    ])))
    const task = await planAndWait(app)
    expect(task.status).toBe('done')
    expect(task.launchedFlightIds).toBeUndefined()
    expect(task.conflicts).toBeUndefined()
  })
})
