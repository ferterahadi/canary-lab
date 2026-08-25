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

/** A store stub whose `get` throws a non-Error value, so error handlers that
 *  branch on `err instanceof Error` take the `String(err)` fallback path. */
function throwingStore(thrown: unknown): FlightStore {
  return {
    list(): FlightIndexEntry[] {
      return []
    },
    get(): FlightManifest | null {
      throw thrown
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
    save(): void {},
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

describe('flights routes', () => {
  it('releases a checkpoint via respond and refuses one when nothing waits', async () => {
    const adapters = allDone()
    adapters.scout = {
      run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'config-approval', message: 'approve?' } }),
      onCheckpointResponse: async () => ({ kind: 'done' as const }),
    }
    app = await buildApp(adapters)
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['waiting-for-approval'])

    const bad = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/respond`, body: {} })
    expect(bad.statusCode).toBe(400)

    const responded = await app.inject({
      method: 'POST',
      url: `/api/flights/${flightId}/respond`,
      body: { response: { choice: 'approve' } },
    })
    expect(responded.statusCode).toBe(200)
    await waitForStatus(flightId, ['done'])

    const again = await app.inject({
      method: 'POST',
      url: `/api/flights/${flightId}/respond`,
      body: { response: { choice: 'approve' } },
    })
    expect(again.statusCode).toBe(409)
  })

  it('a respond against a USER-paused flight returns the typed stand-down body', async () => {
    // The reply an external client gets when the user stopped the flight while it
    // was doing the work. A bare message reads as "retry"; `type` + `pauseReason`
    // are what let it discard instead, and there is no other channel to tell it —
    // nothing can interrupt that client mid-turn.
    const adapters = allDone()
    adapters.scout = {
      teardown: () => null,
      run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'config-approval', message: 'approve?' } }),
      onCheckpointResponse: async () => ({ kind: 'done' as const }),
    }
    app = await buildApp(adapters)
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['waiting-for-approval'])

    expect((await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })).statusCode).toBe(200)
    const late = await app.inject({
      method: 'POST',
      url: `/api/flights/${flightId}/respond`,
      body: { response: { choice: 'approve' } },
    })
    expect(late.statusCode).toBe(409)
    expect(late.json()).toMatchObject({ type: 'flight_not_parked', status: 'paused', pauseReason: 'user' })
  })

  it('R78: POST /autopilot flips the preference on a settled flight; a non-boolean body is a 400', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const off = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/autopilot`, body: { autopilot: false } })
    expect(off.statusCode).toBe(200)
    expect((off.json() as { opts: { autopilot?: boolean } }).opts.autopilot).toBe(false)

    const bad = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/autopilot`, body: {} })
    expect(bad.statusCode).toBe(400)

    const missing = await app.inject({ method: 'POST', url: '/api/flights/fl_nope/autopilot', body: { autopilot: true } })
    expect(missing.statusCode).toBe(404)
  })

  it('resumes a paused flight and aborts an active one', async () => {
    let fail = true
    const adapters = allDone()
    adapters.docs = {
      run: async () => (fail ? { kind: 'failed', error: 'no docs' } : { kind: 'done' }),
    }
    app = await buildApp(adapters)
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['paused'])

    fail = false
    const resumed = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/resume` })
    expect(resumed.statusCode).toBe(200)
    await waitForStatus(flightId, ['done'])

    const reResumed = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/resume` })
    expect(reResumed.statusCode).toBe(409)

    const aborted = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/abort` })
    expect(aborted.statusCode).toBe(200)
    expect((aborted.json() as { status: string }).status).toBe('aborted')
  })

  it('remedy: lists live-dirty repos on a matching failed stage, stashes them, and resumes', async () => {
    const { execFileSync } = await import('child_process')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' })
    fs.writeFileSync(path.join(repoDir, 'f.txt'), 'a')
    git('init')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('add', '-A')
    git('commit', '-m', 'init')
    fs.writeFileSync(path.join(repoDir, 'f.txt'), 'changed') // now dirty

    let fail = true
    const adapters = allDone()
    adapters.portify = {
      run: async () =>
        fail
          ? { kind: 'failed', error: 'portify start rejected (409): repo "r" has uncommitted changes — commit or stash them first' }
          : { kind: 'done' },
    }
    app = await buildApp(adapters)
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['paused'])

    const listed = await app.inject({ method: 'GET', url: `/api/flights/${flightId}/remedy` })
    expect(listed.statusCode).toBe(200)
    const remedy = (listed.json() as { remedy: { kind: string; stage: string; repos: Array<{ path: string; modified: number }> } }).remedy
    expect(remedy).toMatchObject({ kind: 'dirty-repos', stage: 'portify' })
    expect(remedy.repos).toEqual([{ name: 'product-repo', path: repoDir, modified: 1 }])

    const bad = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/remedy`, body: { action: 'shred' } })
    expect(bad.statusCode).toBe(400)

    fail = false
    const applied = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/remedy`, body: { action: 'stash' } })
    expect(applied.statusCode).toBe(200)
    await waitForStatus(flightId, ['done'])
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir }).toString().trim()).toBe('')
    expect(execFileSync('git', ['stash', 'list'], { cwd: repoDir }).toString()).toContain('canary-lab: pre-flight stash')

    // Settled flight has no matching failed stage — remedy self-clears.
    const after = await app.inject({ method: 'GET', url: `/api/flights/${flightId}/remedy` })
    expect((after.json() as { remedy: unknown }).remedy).toBeNull()
  })

  it('remedy: null for a non-matching failure and 409 on apply', async () => {
    const adapters = allDone()
    adapters.docs = { run: async () => ({ kind: 'failed', error: 'no docs' }) }
    app = await buildApp(adapters)
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['paused'])

    const listed = await app.inject({ method: 'GET', url: `/api/flights/${flightId}/remedy` })
    expect((listed.json() as { remedy: unknown }).remedy).toBeNull()
    const applied = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/remedy`, body: { action: 'stash' } })
    expect(applied.statusCode).toBe(409)
  })

  it('404s respond and abort for an unknown flight (real "not found" Error)', async () => {
    app = await buildApp(allDone())
    const respond = await app.inject({
      method: 'POST',
      url: '/api/flights/fl_nope/respond',
      body: { response: { choice: 'approve' } },
    })
    expect(respond.statusCode).toBe(404)
    expect(respond.json()).toMatchObject({ error: 'flight not found: fl_nope' })

    const abort = await app.inject({ method: 'POST', url: '/api/flights/fl_nope/abort' })
    expect(abort.statusCode).toBe(404)
    expect(abort.json()).toMatchObject({ error: 'flight not found: fl_nope' })
  })

  it('falls back to String(err) when respond/resume/abort throw a non-Error', async () => {
    app = await buildApp(allDone(), throwingStore('boom'))

    const respond = await app.inject({
      method: 'POST',
      url: '/api/flights/fl_x/respond',
      body: { response: { choice: 'approve' } },
    })
    expect(respond.statusCode).toBe(409)
    expect(respond.json()).toMatchObject({ error: 'boom' })

    const resume = await app.inject({ method: 'POST', url: '/api/flights/fl_x/resume' })
    expect(resume.statusCode).toBe(409)
    expect(resume.json()).toMatchObject({ error: 'boom' })

    const abort = await app.inject({ method: 'POST', url: '/api/flights/fl_x/abort' })
    expect(abort.statusCode).toBe(409)
    expect(abort.json()).toMatchObject({ error: 'boom' })

    const pause = await app.inject({ method: 'POST', url: '/api/flights/fl_x/pause' })
    expect(pause.statusCode).toBe(409)
    expect(pause.json()).toMatchObject({ error: 'boom' })

    const redo = await app.inject({ method: 'POST', url: '/api/flights/fl_x/redo' })
    expect(redo.statusCode).toBe(409)
    expect(redo.json()).toMatchObject({ error: 'boom' })

    const del = await app.inject({ method: 'DELETE', url: '/api/flights/fl_x' })
    expect(del.statusCode).toBe(409)
    expect(del.json()).toMatchObject({ error: 'boom' })

    const autopilot = await app.inject({ method: 'POST', url: '/api/flights/fl_x/autopilot', body: { autopilot: true } })
    expect(autopilot.statusCode).toBe(409)
    expect(autopilot.json()).toMatchObject({ error: 'boom' })
  })

  it('500s the remedy route when the resume behind it throws a bare value', async () => {
    // The remedy handler honours an err.statusCode when there is one; a thrown
    // non-Error with none must still surface as a server error, not a crash.
    // A remedy-eligible record with no repos left to clean: the remedy itself
    // is a no-op, so the throw can only come from the resume behind it.
    const manifest = {
      flightId: 'fl_x', feature: 'checkout', repoPaths: [], status: 'paused',
      stages: [{ key: 'scout', status: 'failed', error: 'repo has uncommitted changes' }],
    } as unknown as FlightManifest
    const store: FlightStore = { ...throwingStore('unused'), get: () => manifest, save: () => { throw 'resume exploded' } }
    app = await buildApp(allDone(), store)

    const resp = await app.inject({ method: 'POST', url: '/api/flights/fl_x/remedy', body: { action: 'stash' } })

    expect(resp.statusCode).toBe(500)
    expect(resp.json()).toMatchObject({ error: 'resume exploded' })
  })

  it('404s a redo for an unknown flight (real "not found" Error)', async () => {
    app = await buildApp(allDone())
    const resp = await app.inject({ method: 'POST', url: '/api/flights/fl_nope/redo' })
    expect(resp.statusCode).toBe(404)
    expect(resp.json()).toMatchObject({ error: 'flight not found: fl_nope' })
  })

  it('400s a redo that jumps to a stage whose prerequisite is missing', async () => {
    // The jump is rejected by the same validator the start route uses, and the
    // dialog switches on `type` to show the prerequisite instead of a raw error.
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const resp = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/redo`, body: { fromStage: 'evaluation-export' } })

    expect(resp.statusCode).toBe(400)
    expect(resp.json()).toMatchObject({ type: 'stage_entry_rejected' })
    expect(resp.json().error).toMatch(/Evaluation report/)
  })

  describe('agent-session', () => {
    it('400s when the stage query is missing or malformed', async () => {
      app = await buildApp(allDone())
      const missing = await app.inject({ method: 'GET', url: '/api/flights/fl_x/agent-session' })
      expect(missing.statusCode).toBe(400)

      const malformed = await app.inject({
        method: 'GET',
        url: '/api/flights/fl_x/agent-session?stage=Not_Valid!',
      })
      expect(malformed.statusCode).toBe(400)
    })

    it('404s when no agent-session ref exists for the stage', async () => {
      app = await buildApp(allDone())
      const resp = await app.inject({ method: 'GET', url: '/api/flights/fl_x/agent-session?stage=scout' })
      expect(resp.statusCode).toBe(404)
      expect(resp.json()).toEqual({ reason: 'no-session' })
    })

    it('returns the agent session when a ref is on disk', async () => {
      const store = new FlightRunStore(tmpDir)
      app = await buildApp(allDone(), store)
      const stageDir = path.join(store.flightDir('fl_x'), 'scout')
      fs.mkdirSync(stageDir, { recursive: true })
      const logPath = path.join(stageDir, 'session.jsonl')
      fs.writeFileSync(
        logPath,
        `${JSON.stringify({ type: 'assistant', message: { model: 'claude-x' } })}\n`,
      )
      fs.writeFileSync(
        path.join(stageDir, 'agent-session.json'),
        JSON.stringify({ agent: 'claude', sessionId: 'sess-1', logPath }),
      )

      const resp = await app.inject({ method: 'GET', url: '/api/flights/fl_x/agent-session?stage=scout' })
      expect(resp.statusCode).toBe(200)
      const body = resp.json() as { agent: string; sessionId: string; model?: string; events: unknown[] }
      expect(body.agent).toBe('claude')
      expect(body.sessionId).toBe('sess-1')
      expect(body.model).toBe('claude-x')
    })
  })
  // The guard's own truth table lives in flight-decision-origin.test.ts; these
  // prove the WIRING — that each decision route consults it, and that the
  // escape hatch and the read routes do not.
  describe('externally driven flights', () => {
    const external = (): FlightStore => {
      const store = new FlightRunStore(tmpDir)
      store.save({
        flightId: 'fl_x',
        feature: 'checkout',
        repoPaths: [repoDir],
        description: 'checkout flow',
        opts: { env: 'local', yolo: false, stageProducer: 'external' },
        status: 'paused',
        pauseReason: 'user',
        currentStage: 'docs',
        stages: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as FlightManifest)
      return store
    }

    it.each([
      ['respond', { method: 'POST' as const, url: '/api/flights/fl_x/respond', body: { response: { choice: 'approve' } } }],
      ['resume', { method: 'POST' as const, url: '/api/flights/fl_x/resume' }],
      ['pause', { method: 'POST' as const, url: '/api/flights/fl_x/pause' }],
      ['autopilot', { method: 'POST' as const, url: '/api/flights/fl_x/autopilot', body: { autopilot: false } }],
      ['redo', { method: 'POST' as const, url: '/api/flights/fl_x/redo' }],
    ])('409s a browser %s', async (_name, req) => {
      app = await buildApp(allDone(), external())
      const resp = await app.inject(req)
      expect(resp.statusCode).toBe(409)
      expect(resp.json()).toMatchObject({ type: 'flight_externally_driven' })
    })

    it('lets the MCP client resume the same flight', async () => {
      app = await buildApp(allDone(), external())
      const resp = await app.inject({
        method: 'POST',
        url: '/api/flights/fl_x/resume',
        headers: { 'x-canary-origin': 'mcp' },
      })
      expect(resp.statusCode).toBe(200)
    })

    // Abort is the escape hatch when the driving client has gone away, and the
    // read routes were never in question — a viewer has to be able to view.
    it('leaves abort and the read routes open to the browser', async () => {
      app = await buildApp(allDone(), external())
      expect((await app.inject({ method: 'GET', url: '/api/flights/fl_x' })).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: '/api/flights/fl_x/abort' })).statusCode).toBe(200)
    })

    function handOffAdapters(): StageAdapters {
      const adapters = allDone()
      adapters.scout = {
        teardown: () => null,
        run: async () => ({
          kind: 'checkpoint',
          checkpoint: {
            kind: 'external-work',
            message: 'do the scout step',
            options: ['submit', 'run-internally'],
            data: { stage: 'scout', prompt: 'scan it', handOffId: 'abc12345' },
          },
        }),
        onCheckpointResponse: async (_ctx, response) => (
          response.choice === 'run-internally'
            ? { kind: 'done' as const }
            : { kind: 'failed' as const, error: 'external submit should not reach the adapter after takeover' }
        ),
      }
      return adapters
    }

    async function startExternalHandOff(): Promise<string> {
      const started = await app.inject({
        method: 'POST',
        url: '/api/flights',
        body: startBody({ stageProducer: 'external' }),
      })
      const flightId = (started.json() as { flightId: string }).flightId
      await waitForStatus(flightId, ['waiting-for-approval'])
      return flightId
    }

    it('requests a cooperative takeover, rejects submit, then starts internally after release', async () => {
      const store = new FlightRunStore(tmpDir)
      app = await buildApp(handOffAdapters(), store)
      const flightId = await startExternalHandOff()

      const requested = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/takeover/request` })
      expect(requested.statusCode).toBe(200)
      const requestedManifest = requested.json() as FlightManifest
      const requestedStage = requestedManifest.stages.find((stage) => stage.key === 'scout')!
      expect(requestedStage.checkpoint?.data).toMatchObject({
        handOffId: 'abc12345',
        takeoverRequestedAt: expect.any(String),
      })
      expect(requestedStage.log).toContain('waiting for the external agent to release this step')

      // Idempotent: a double click does not append a second Activity row.
      const requestedAgain = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/takeover/request` })
      const repeatedLog = ((requestedAgain.json() as FlightManifest).stages.find((stage) => stage.key === 'scout')?.log ?? '')
      expect(repeatedLog.match(/waiting for the external agent to release this step/g)).toHaveLength(1)

      const submit = await app.inject({
        method: 'POST',
        url: `/api/flights/${flightId}/respond`,
        headers: { 'x-canary-origin': 'mcp' },
        body: { response: { choice: 'submit', token: 'abc12345', data: { configSource: 'late' } } },
      })
      expect(submit.statusCode).toBe(409)
      expect(submit.json()).toMatchObject({
        type: 'flight_takeover_requested',
        requestedAt: expect.any(String),
      })
      expect((await app.inject({ method: 'GET', url: `/api/flights/${flightId}` })).json())
        .toMatchObject({ status: 'waiting-for-approval' })

      // Compatibility: a persisted request from a build that did not write an
      // Activity line is still releasable, and the acknowledgement creates the
      // log from an empty base rather than producing "undefined...".
      const withoutLog = store.get(flightId)!
      store.save({
        ...withoutLog,
        stages: withoutLog.stages.map((stage) => stage.key === 'scout'
          ? { ...stage, log: undefined }
          : stage),
      })
      const released = await app.inject({
        method: 'POST',
        url: `/api/flights/${flightId}/respond`,
        headers: { 'x-canary-origin': 'mcp' },
        body: { response: { choice: 'run-internally' } },
      })
      expect(released.statusCode).toBe(200)
      const done = await waitForStatus(flightId, ['done']) as unknown as FlightManifest
      expect(done.stages.find((stage) => stage.key === 'scout')?.log)
        .toContain('The external agent released this step — Canary is taking over')
    })

    it('forces only a requested takeover and records the unsafe hand-off', async () => {
      app = await buildApp(handOffAdapters())
      const flightId = await startExternalHandOff()

      expect((await app.inject({
        method: 'POST', url: `/api/flights/${flightId}/takeover/force`, body: { confirm: true },
      })).statusCode).toBe(409)
      expect((await app.inject({
        method: 'POST', url: `/api/flights/${flightId}/takeover/force`, body: {},
      })).statusCode).toBe(400)

      expect((await app.inject({
        method: 'POST', url: `/api/flights/${flightId}/takeover/request`,
      })).statusCode).toBe(200)
      const forced = await app.inject({
        method: 'POST', url: `/api/flights/${flightId}/takeover/force`, body: { confirm: true },
      })
      expect(forced.statusCode).toBe(200)
      const done = await waitForStatus(flightId, ['done']) as unknown as FlightManifest
      expect(done.stages.find((stage) => stage.key === 'scout')?.log)
        .toContain('User forced takeover — Canary is starting this step here')
    })

    it('rejects takeover when there is no external work hand-off', async () => {
      app = await buildApp(allDone())
      const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
      const flightId = (started.json() as { flightId: string }).flightId
      await waitForStatus(flightId, ['done'])
      const settled = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/takeover/request` })
      expect(settled.statusCode).toBe(409)
      expect(settled.json()).toMatchObject({ type: 'flight_takeover_unavailable' })
      expect((await app.inject({ method: 'POST', url: '/api/flights/missing/takeover/request' })).statusCode).toBe(404)
      expect((await app.inject({
        method: 'POST', url: '/api/flights/missing/takeover/force', body: { confirm: true },
      })).statusCode).toBe(404)
    })

    it.each([
      ['no waiting stage', [], { stageProducer: 'external' as const }],
      ['a different checkpoint kind', [{ key: 'scout', status: 'waiting-for-approval' as const, checkpoint: { kind: 'config-approval' as const, message: 'approve?' } }], { stageProducer: 'external' as const }],
      ['an internal producer', [{ key: 'scout', status: 'waiting-for-approval' as const, checkpoint: { kind: 'external-work' as const, message: 'work', data: {} } }], { stageProducer: 'internal' as const }],
    ])('rejects malformed takeover state: %s', async (_label, stages, producer) => {
      const store = new FlightRunStore(tmpDir)
      store.save({
        flightId: 'fl_malformed',
        feature: 'checkout',
        repoPaths: [repoDir],
        description: 'checkout flow',
        opts: { env: 'local', coverageTarget: 100, yolo: false, ...producer },
        status: 'waiting-for-approval',
        currentStage: 'scout',
        stages,
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      } as FlightManifest)
      app = await buildApp(allDone(), store)
      const response = await app.inject({
        method: 'POST', url: '/api/flights/fl_malformed/takeover/request',
      })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ type: 'flight_takeover_unavailable' })
    })

    it('maps non-Error takeover store failures on both routes', async () => {
      app = await buildApp(allDone(), throwingStore('takeover store failed'))
      const requested = await app.inject({
        method: 'POST', url: '/api/flights/fl_x/takeover/request',
      })
      expect(requested.statusCode).toBe(409)
      expect(requested.json()).toMatchObject({ error: 'takeover store failed' })
      const forced = await app.inject({
        method: 'POST', url: '/api/flights/fl_x/takeover/force', body: { confirm: true },
      })
      expect(forced.statusCode).toBe(409)
      expect(forced.json()).toMatchObject({ error: 'takeover store failed' })
    })
  })
})
