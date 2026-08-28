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

import type { PlanFeaturesTask, PlannedFeature } from '../../../../../../shared/flights/types'

import { PlanFeaturesStore, startPlanFeatures, normalizePlanResult } from '../logic/plan-features'

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

  it('runs the plan agent and settles the proposal (normalized, deduped names)', async () => {
    app = await buildApp(allDone(), undefined, agentReturning(planText([
      { name: 'Auth Flow', description: 'test login + signup', scope: 'auth only', group: 'My Shop' },
      { name: 'checkout-flow', description: 'test the checkout', scope: 'cart to payment', group: 'My Shop' },
    ])))
    const task = await planAndWait(app)
    expect(task.status).toBe('done')
    expect(task.result).toMatchObject({
      split: true,
      features: [
        { name: 'auth-flow', description: 'test login + signup', group: 'my-shop' },
        { name: 'checkout-flow', description: 'test the checkout', group: 'my-shop' },
      ],
    })
  })

  it('an unparseable agent answer fails the task with the parse story', async () => {
    app = await buildApp(allDone(), undefined, agentReturning('I could not decide.'))
    const task = await planAndWait(app)
    expect(task.status).toBe('failed')
    expect(task.error).toMatch(/JSON/)
  })

  it('GET plan-features lists running/done tasks and drops launched ones', async () => {
    app = await buildApp(allDone(), undefined, agentReturning(planText([
      { name: 'alpha', description: 'test alpha' },
      { name: 'beta', description: 'test beta' },
    ])))
    const task = await planAndWait(app) // multi-feature → done, awaiting the human
    const listed = await app.inject({ method: 'GET', url: '/api/flights/plan-features' })
    expect((listed.json() as { tasks: PlanFeaturesTask[] }).tasks.map((t) => t.taskId)).toContain(task.taskId)
    await app.inject({
      method: 'POST',
      url: `/api/flights/plan-features/${task.taskId}/launch`,
      body: { features: task.result!.features },
    })
    const after = await app.inject({ method: 'GET', url: '/api/flights/plan-features' })
    expect((after.json() as { tasks: PlanFeaturesTask[] }).tasks.map((t) => t.taskId)).not.toContain(task.taskId)
  })

  it('POST attaches to a running task for the same inputs instead of double-spawning', async () => {
    let spawns = 0
    let release: (() => void) | null = null
    const gated: FlightAgentSpawner = async () => {
      spawns += 1
      await new Promise<void>((resolve) => { release = resolve })
      return { text: planText([{ name: 'solo', description: 'test solo' }]) }
    }
    app = await buildApp(allDone(), undefined, gated)
    const body = { repoPaths: [repoDir], description: 'test everything in this repo' }
    const first = await app.inject({ method: 'POST', url: '/api/flights/plan-features', body })
    const second = await app.inject({ method: 'POST', url: '/api/flights/plan-features', body })
    expect((second.json() as { taskId: string }).taskId).toBe((first.json() as { taskId: string }).taskId)
    expect(spawns).toBe(1)
    release!()
  })

  it('defaults an undefined plan-features POST body to {} and 400s on missing repoPaths', async () => {
    app = await buildApp(allDone())
    const resp = await app.inject({ method: 'POST', url: '/api/flights/plan-features' })
    expect(resp.statusCode).toBe(400)
    expect(resp.json()).toMatchObject({ error: 'repoPaths (non-empty string array) is required' })
  })

  it('validates the plan-features start payload', async () => {
    app = await buildApp(allDone())
    for (const body of [
      {},
      { repoPaths: [], description: 'test everything' },
      { repoPaths: [repoDir, 123], description: 'test everything' },
      { repoPaths: [repoDir] },
      { repoPaths: [repoDir], description: '  ' },
    ]) {
      const resp = await app.inject({ method: 'POST', url: '/api/flights/plan-features', body })
      expect(resp.statusCode).toBe(400)
    }
  })

  it('400s a repo path that does not exist', async () => {
    app = await buildApp(allDone())
    const resp = await app.inject({
      method: 'POST',
      url: '/api/flights/plan-features',
      body: { repoPaths: [path.join(tmpDir, 'nope')], description: 'test everything' },
    })
    expect(resp.statusCode).toBe(400)
    expect(resp.json()).toMatchObject({ error: expect.stringContaining('repo path does not exist') })
  })

  it('404s GET plan-features/:taskId for an unknown task', async () => {
    app = await buildApp(allDone())
    const resp = await app.inject({ method: 'GET', url: '/api/flights/plan-features/fp_nope' })
    expect(resp.statusCode).toBe(404)
    expect(resp.json()).toMatchObject({ error: 'plan task not found: fp_nope' })
  })

  describe('agent-session', () => {
    it('404s when no agent-session ref exists for the plan task', async () => {
      app = await buildApp(allDone(), undefined, agentReturning(planText([
        { name: 'alpha', description: 'test alpha' },
        { name: 'beta', description: 'test beta' },
      ])))
      const task = await planAndWait(app)
      const resp = await app.inject({ method: 'GET', url: `/api/flights/plan-features/${task.taskId}/agent-session` })
      expect(resp.statusCode).toBe(404)
      expect(resp.json()).toEqual({ reason: 'no-session' })
    })

    it('returns the agent session when a ref is on disk for the plan task', async () => {
      const planStore = new PlanFeaturesStore(tmpDir)
      app = await buildApp(allDone(), undefined, agentReturning(planText([
        { name: 'alpha', description: 'test alpha' },
        { name: 'beta', description: 'test beta' },
      ])))
      const task = await planAndWait(app)
      const recordDir = planStore.recordDir(task.taskId)
      const logPath = path.join(recordDir, 'session.jsonl')
      fs.writeFileSync(logPath, `${JSON.stringify({ type: 'assistant', message: { model: 'claude-x' } })}\n`)
      fs.writeFileSync(
        path.join(recordDir, 'agent-session.json'),
        JSON.stringify({ agent: 'claude', sessionId: 'sess-1', logPath }),
      )

      const resp = await app.inject({ method: 'GET', url: `/api/flights/plan-features/${task.taskId}/agent-session` })
      expect(resp.statusCode).toBe(200)
      const body = resp.json() as { agent: string; sessionId: string; model?: string }
      expect(body.agent).toBe('claude')
      expect(body.sessionId).toBe('sess-1')
      expect(body.model).toBe('claude-x')
    })
  })

  it('a plan agent spawn throwing a non-Error value fails the task via String(err)', async () => {
    app = await buildApp(allDone(), undefined, async () => {
      throw 'agent crashed'
    })
    const task = await planAndWait(app)
    expect(task.status).toBe('failed')
    expect(task.error).toBe('agent crashed')
  })
})

describe('plan-features.ts direct unit coverage (paths no route surface reaches)', () => {
  it('normalizePlanResult rejects zero suites, a missing description, and duplicate names', () => {
    expect(() => normalizePlanResult({ split: false, features: [] })).toThrow(/no suites/)
    expect(() =>
      normalizePlanResult({ split: false, features: [{ name: 'x' } as PlannedFeature] }),
    ).toThrow(/has no description/)
    expect(() =>
      normalizePlanResult({
        split: true,
        features: [
          { name: 'dup', description: 'd1' },
          { name: 'dup', description: 'd2' },
        ],
      }),
    ).toThrow(/duplicate suite names/)
  })

  it('normalizePlanResult falls back to "feature" when the name key is entirely absent', () => {
    // Exercises the `f?.name ?? ''` nullish fallback distinct from an
    // explicit empty-string name (deriveFeatureSlug('') → 'feature').
    const result = normalizePlanResult({
      split: false,
      features: [{ description: 'no name field at all' } as PlannedFeature],
    })
    expect(result.features).toEqual([{ name: 'feature', description: 'no name field at all' }])
  })

  it('reconcileInterrupted fails an orphaned running plan task on boot', () => {
    const store = new PlanFeaturesStore(tmpDir)
    store.save({
      taskId: 'fp_orphan',
      repoPaths: [repoDir],
      description: 'orphaned',
      status: 'running',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    store.reconcileInterrupted(() => '2026-01-02T00:00:00Z')
    const after = store.get('fp_orphan')!
    expect(after.status).toBe('failed')
    expect(after.error).toMatch(/Interrupted by server restart/)
  })

  it('a client /launch that wins the race is not overwritten by the server auto-launch', async () => {
    const store = new PlanFeaturesStore(tmpDir)
    let capturedStatus: string | undefined
    const task = startPlanFeatures(
      { repoPaths: [repoDir], description: 'race test' },
      store,
      {
        logsDir: tmpDir,
        spawnAgent: async () => ({ text: planText([{ name: 'race-one', description: 'test race' }]) }),
        autoLaunch: (settled) => {
          // Simulate a concurrent client POST /launch beating the server's
          // own auto-launch and flipping status before this callback returns.
          store.save({ ...settled, status: 'launched', launchedFlightIds: ['fl_client'], updatedAt: '2026-01-01T00:00:01Z' })
          capturedStatus = store.get(settled.taskId)?.status
          return { launched: true, flightIds: ['fl_server_would_have_made'] }
        },
      },
    )
    const deadline = Date.now() + 3000
    while (store.get(task.taskId)?.status === 'running') {
      if (Date.now() > deadline) throw new Error('plan task never settled')
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(capturedStatus).toBe('launched')
    // The guard refused to resurrect/overwrite — the client's write wins.
    const final = store.get(task.taskId)!
    expect(final.status).toBe('launched')
    expect(final.launchedFlightIds).toEqual(['fl_client'])
  })

  it('settle() no-ops (does not resurrect) when the record file vanishes before the agent resolves', async () => {
    // Exercises the `!cur` half of settle()'s `!cur || cur.status !== 'running'`
    // guard, distinct from the `status !== 'running'` half already covered by
    // the non-conflict-auto-launch test above.
    const store = new PlanFeaturesStore(tmpDir)
    let release: (() => void) | null = null
    const task = startPlanFeatures(
      { repoPaths: [repoDir], description: 'vanishing record' },
      store,
      {
        logsDir: tmpDir,
        spawnAgent: async () => {
          await new Promise<void>((resolve) => { release = resolve })
          return { text: planText([{ name: 'ghost-one', description: 'test ghost' }]) }
        },
      },
    )
    // Delete the on-disk record while the agent is still "running" — settle()
    // must find no current record and bail out rather than writing one back.
    fs.rmSync(path.join(store.recordDir(task.taskId), 'plan.json'), { force: true })
    release!()
    // Give the detached runPlanAgent a beat to reach settle().
    await new Promise((r) => setTimeout(r, 50))
    expect(store.get(task.taskId)).toBeNull()
  })

  it('the post-autoLaunch save is skipped when the record vanishes during autoLaunch (line-196 !cur guard)', async () => {
    // Distinct from the race test above (which hits `cur.status !== 'done'`):
    // here the record disappears entirely between the `done` settle and the
    // post-autoLaunch re-read, exercising the `!cur` half of that guard.
    const store = new PlanFeaturesStore(tmpDir)
    const task = startPlanFeatures(
      { repoPaths: [repoDir], description: 'vanishing during autolaunch' },
      store,
      {
        logsDir: tmpDir,
        spawnAgent: async () => ({ text: planText([{ name: 'solo-ghost', description: 'test solo ghost' }]) }),
        autoLaunch: (settled) => {
          fs.rmSync(path.join(store.recordDir(settled.taskId), 'plan.json'), { force: true })
          return { launched: true, flightIds: ['fl_would_have_made'] }
        },
      },
    )
    const deadline = Date.now() + 3000
    for (;;) {
      if (store.get(task.taskId) === null) break
      if (Date.now() > deadline) throw new Error('record never vanished / task never settled')
      await new Promise((r) => setTimeout(r, 10))
    }
    // Stayed gone — the guard refused to write a 'launched' record back onto
    // a deleted task.
    expect(store.get(task.taskId)).toBeNull()
  })
})

describe('~-relative repo paths (dialog picker parity)', () => {
  it('expands a leading ~ on start like the entry prefill does', async () => {
    const os = await import('os')
    const home = os.homedir()
    const rel = `.cl-flight-route-test-${process.pid}`
    const abs = path.join(home, rel)
    fs.mkdirSync(abs, { recursive: true })
    try {
      app = await buildApp(allDone())
      const started = await app.inject({
        method: 'POST',
        url: '/api/flights',
        body: startBody({ repoPaths: [`~/${rel}`] }),
      })
      expect(started.statusCode).toBe(201)
      expect((started.json() as { repoPaths: string[] }).repoPaths[0]).toBe(fs.realpathSync(abs))
    } finally {
      fs.rmSync(abs, { recursive: true, force: true })
    }
  })
})
