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
    flightDir(flightId: string): string {
      return path.join(tmpDir, 'flights', flightId)
    },
    reconcileInterrupted(): void {},
    onEvent(_fn: (event: FlightStoreEvent) => void): void {},
    offEvent(_fn: (event: FlightStoreEvent) => void): void {},
  }
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

describe('flights routes', () => {
  it('validates the start payload', async () => {
    app = await buildApp(allDone())
    for (const body of [
      {},
      startBody({ repoPaths: [] }),
      startBody({ description: ' ' }),
      startBody({ feature: '' }),
      startBody({ coverageTarget: 200 }),
      startBody({ repoPaths: [path.join(tmpDir, 'nope')] }),
    ]) {
      const resp = await app.inject({ method: 'POST', url: '/api/flights', body })
      expect(resp.statusCode).toBe(400)
    }
  })

  it('starts a flight (201, non-blocking) and exposes it via list + get', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    expect(started.statusCode).toBe(201)
    const manifest = started.json() as { flightId: string; status: string; repoPaths: string[] }
    expect(manifest.status).toBe('running')
    expect(manifest.repoPaths).toEqual([repoDir])

    const listed = await app.inject({ method: 'GET', url: '/api/flights' })
    expect((listed.json() as { flights: unknown[] }).flights).toHaveLength(1)

    const settled = await waitForStatus(manifest.flightId, ['done'])
    expect(settled.currentStage).toBeNull()
  })

  it('409s a second start for the same repo while one is active (single-flight)', async () => {
    const adapters = allDone()
    adapters.scout = {
      run: async () => ({ kind: 'checkpoint', checkpoint: { kind: 'config-approval', message: 'approve?' } }),
    }
    app = await buildApp(adapters)
    const first = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (first.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['waiting-for-approval'])

    const dup = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ feature: 'other' }) })
    expect(dup.statusCode).toBe(409)
    expect(dup.json()).toMatchObject({ type: 'flight_conflict', existingFlightId: flightId })
  })

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

  it('404s an unknown flight', async () => {
    app = await buildApp(allDone())
    const resp = await app.inject({ method: 'GET', url: '/api/flights/fl_nope' })
    expect(resp.statusCode).toBe(404)
    const resumed = await app.inject({ method: 'POST', url: '/api/flights/fl_nope/resume' })
    expect(resumed.statusCode).toBe(404)
    const remedy = await app.inject({ method: 'GET', url: '/api/flights/fl_nope/remedy' })
    expect(remedy.statusCode).toBe(404)
    const applied = await app.inject({ method: 'POST', url: '/api/flights/fl_nope/remedy', body: { action: 'stash' } })
    expect(applied.statusCode).toBe(404)
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

  it('accepts an explicit base branch option', async () => {
    app = await buildApp(allDone())
    const resp = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: startBody({ base: 'develop' }),
    })
    expect(resp.statusCode).toBe(201)
    const manifest = resp.json() as { opts: { base?: string } }
    expect(manifest.opts.base).toBe('develop')
  })

  it('builds its own store when flightStore is omitted', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    expect(started.statusCode).toBe(201)
    const flightId = (started.json() as { flightId: string }).flightId
    const fetched = await app.inject({ method: 'GET', url: `/api/flights/${flightId}` })
    expect(fetched.statusCode).toBe(200)
  })

  it('defaults an undefined POST body to {} and 400s on missing repoPaths', async () => {
    app = await buildApp(allDone())
    const resp = await app.inject({ method: 'POST', url: '/api/flights' })
    expect(resp.statusCode).toBe(400)
    expect(resp.json()).toMatchObject({ error: 'repoPaths (non-empty string array) is required' })
  })

  it('rethrows a non-conflict error raised while starting a flight', async () => {
    app = await buildApp(allDone(), saveThrowsStore('disk full'))
    const resp = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    expect(resp.statusCode).toBe(500)
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
    expect(resp.json().error).toMatch(/evaluation-export/)
  })

  it('carries autopilot:false from the start payload into the flight options', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ autopilot: false, agent: 'codex' }) })
    expect(started.statusCode).toBe(201)
    expect((started.json() as { opts: { autopilot?: boolean; agent?: string } }).opts).toMatchObject({ autopilot: false, agent: 'codex' })
  })

  it('400s when repoPaths contains a non-string entry', async () => {
    app = await buildApp(allDone())
    const resp = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: startBody({ repoPaths: [repoDir, 123] }),
    })
    expect(resp.statusCode).toBe(400)
    expect(resp.json()).toMatchObject({ error: 'repoPaths must be a string array' })
  })

  it('degrades gracefully when the feature config directory cannot be read (loadFeatures throws)', async () => {
    // featuresDir is a FILE, not a directory — loadFeatures's fs.readdirSync
    // throws ENOTDIR, which the entry route's best-effort try/catch must
    // swallow rather than 500ing the whole menu.
    fs.writeFileSync(path.join(tmpDir, 'features'), 'not a directory')
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    await waitForStatus((started.json() as { flightId: string }).flightId, ['done'])

    const resp = await app.inject({ method: 'GET', url: '/api/flights/entry?feature=checkout' })
    expect(resp.statusCode).toBe(200)
    const body = resp.json() as { prefill: { repoPaths: string[] } }
    // config load failed → falls back to the manifest's repoPaths, not a
    // config-derived prefill.
    expect(body.prefill.repoPaths).toEqual([repoDir])
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
})

describe('flight entry modes (continue / redo / jump)', () => {
  it('400s an invalid mode and an invalid fromStage', async () => {
    app = await buildApp(allDone())
    const badMode = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ mode: 'sideways' }) })
    expect(badMode.statusCode).toBe(400)
    expect((badMode.json() as { error: string }).error).toMatch(/invalid mode/)

    const badStage = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ fromStage: 'warp' }) })
    expect(badStage.statusCode).toBe(400)
    expect((badStage.json() as { error: string }).error).toMatch(/invalid fromStage/)
  })

  it('409s flight_exists_requires_choice on a modeless re-start, and redo reuses the record', async () => {
    app = await buildApp(allDone())
    const first = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (first.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const again = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    expect(again.statusCode).toBe(409)
    const body = again.json() as { type: string; options: string[]; existingFlightId: string }
    expect(body.type).toBe('flight_exists_requires_choice')
    expect(body.options).toEqual(['continue', 'redo', 'jump'])
    expect(body.existingFlightId).toBe(flightId)

    const redo = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ mode: 'redo' }) })
    expect(redo.statusCode).toBe(201)
    expect((redo.json() as { flightId: string }).flightId).toBe(flightId)
    const listed = await app.inject({ method: 'GET', url: '/api/flights' })
    expect((listed.json() as { flights: unknown[] }).flights).toHaveLength(1)
    await waitForStatus(flightId, ['done'])
  })

  it('rejects a jump whose prerequisites are missing, naming the first missing artifact', async () => {
    app = await buildApp(allDone())
    const jump = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: startBody({ fromStage: 'specs-coverage' }),
    })
    expect(jump.statusCode).toBe(400)
    const body = jump.json() as { type: string; error: string }
    expect(body.type).toBe('stage_entry_rejected')
    expect(body.error).toMatch(/feature\.config\.cjs/)
  })

  it('accepts a jump whose on-disk prerequisites exist (fresh feature, stage-entry skips recorded)', async () => {
    const featureDir = path.join(tmpDir, 'features', 'checkout_flow')
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'api.env'), 'PORT=0\n')
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), '{}')

    app = await buildApp(allDone())
    const jump = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: startBody({ feature: 'checkout_flow', fromStage: 'specs-coverage' }),
    })
    expect(jump.statusCode).toBe(201)
    const manifest = jump.json() as { flightId: string; stages: Array<{ key: string; status: string; skipReason?: string }> }
    const scout = manifest.stages.find((s) => s.key === 'scout')!
    expect(scout.status).toBe('skipped')
    expect(scout.skipReason).toBe('stage-entry')
    await waitForStatus(manifest.flightId, ['done'])
  })

  it('rejects a heal entry point outright', async () => {
    app = await buildApp(allDone())
    const jump = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ fromStage: 'heal' }) })
    expect(jump.statusCode).toBe(400)
    expect((jump.json() as { error: string }).error).toMatch(/use --from-stage run/)
  })

  it('rejects a jump to run when no PRD summary exists (prd-summary prerequisite)', async () => {
    const featureDir = path.join(tmpDir, 'features', 'checkout')
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'api.env'), 'PORT=0\n')
    app = await buildApp(allDone())
    const jump = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ fromStage: 'run' }) })
    expect(jump.statusCode).toBe(400)
    const body = jump.json() as { type: string; error: string }
    expect(body.type).toBe('stage_entry_rejected')
    expect(body.error).toMatch(/_prd-summary\.json/)
  })

  it('rejects a jump to run when no specs exist under e2e/ (specs-coverage prerequisite)', async () => {
    const featureDir = path.join(tmpDir, 'features', 'checkout')
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'api.env'), 'PORT=0\n')
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), '{}')
    app = await buildApp(allDone())
    const jump = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ fromStage: 'run' }) })
    expect(jump.statusCode).toBe(400)
    const body = jump.json() as { type: string; error: string }
    expect(body.type).toBe('stage_entry_rejected')
    expect(body.error).toMatch(/no specs under e2e\//)
  })

  it('accepts a jump to env-capture with only the scaffold prerequisite met', async () => {
    const featureDir = path.join(tmpDir, 'features', 'checkout')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'module.exports = {}\n')
    app = await buildApp(allDone())
    const jump = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ fromStage: 'env-capture' }) })
    expect(jump.statusCode).toBe(201)
    await waitForStatus((jump.json() as { flightId: string }).flightId, ['done'])
  })
})

describe('flight entry options (GET /api/flights/entry)', () => {
  interface EntryBody {
    feature: string
    flight: { flightId: string; status: string; stages: Array<{ key: string; status: string }> } | null
    active: boolean
    canContinue: boolean
    prefill: { repoPaths: string[]; description: string; env: string; coverageTarget: number }
    stages: Array<{ key: string; allowed: boolean; reason?: string }>
  }
  const entryFor = async (feature: string) => {
    const resp = await app.inject({ method: 'GET', url: `/api/flights/entry?feature=${feature}` })
    return { status: resp.statusCode, body: resp.json() as EntryBody }
  }
  const stageOf = (body: EntryBody, key: string) => body.stages.find((s) => s.key === key)!

  /** A real feature.config the loader can parse, with declared repos. */
  function writeFeatureConfig(feature: string): string {
    const featureDir = path.join(tmpDir, 'features', feature)
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(
      path.join(featureDir, 'feature.config.cjs'),
      `module.exports.config = { name: '${feature}', repos: [{ name: 'app', localPath: '${repoDir}' }] }\n`,
    )
    return featureDir
  }

  it('400s without a feature and 404s a feature with no record and no config', async () => {
    app = await buildApp(allDone())
    expect((await app.inject({ method: 'GET', url: '/api/flights/entry' })).statusCode).toBe(400)
    const missing = await entryFor('ghost')
    expect(missing.status).toBe(404)
  })

  it('expands ~ in config-declared repo paths for the prefill', async () => {
    const featureDir = path.join(tmpDir, 'features', 'homey')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(
      path.join(featureDir, 'feature.config.cjs'),
      `module.exports.config = { name: 'homey', repos: [{ name: 'app', localPath: '~/some/repo' }] }\n`,
    )
    app = await buildApp(allDone())
    const { body } = await entryFor('homey')
    expect(body.prefill.repoPaths).toEqual([path.join(os.homedir(), 'some/repo')])
  })

  // R81 (replaces the R41 blanket lock): a stage is gated by EVIDENCE, not by
  // the existence of a flight record. Work done outside the conductor completes
  // the same stage the conductor would have, so it opens the same entry point.
  it('gates a never-flown feature on evidence, not on having a record — R81', async () => {
    writeFeatureConfig('checkout')
    app = await buildApp(allDone())
    const { status, body } = await entryFor('checkout')
    expect(status).toBe(200)
    expect(body.flight).toBeNull()
    expect(body.active).toBe(false)
    expect(body.canContinue).toBe(false)
    expect(body.prefill.repoPaths).toEqual([repoDir])
    expect(body.prefill.description).toBe('')
    // Config on disk → everything up to and including env-capture is enterable
    // with no flight record at all.
    for (const key of ['similarity', 'scout', 'scaffold', 'env-capture'] as const) {
      expect(stageOf(body, key)).toMatchObject({ allowed: true })
    }
    // Past that the artifacts don't exist yet, so the validator — not a record
    // check — is what blocks, and it names the missing prerequisite.
    for (const key of ['docs', 'specs-coverage', 'run'] as const) {
      expect(stageOf(body, key)).toMatchObject({ allowed: false })
      expect(stageOf(body, key).reason).toMatch(/env-capture prerequisite/)
      expect(stageOf(body, key).reason).not.toMatch(/first flight/)
    }
  })

  it('unlocks a stage for a never-flown feature once its evidence is on disk — R81', async () => {
    const featureDir = writeFeatureConfig('checkout')
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'api.env'), 'PORT=0\n')
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), '{}')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'checkout.spec.ts'), '// spec\n')

    app = await buildApp(allDone())
    const { body } = await entryFor('checkout')
    // Never flown — the suite was built by standalone/MCP work — yet the whole
    // pipeline up to `run` is enterable, because the artifacts are all there.
    expect(body.flight).toBeNull()
    for (const key of ['docs', 'specs-coverage', 'run'] as const) {
      expect(stageOf(body, key)).toMatchObject({ allowed: true })
    }
    // Export still needs a run — no record and no passed run on disk.
    expect(stageOf(body, 'evaluation-export')).toMatchObject({ allowed: false })
  })

  it('unlocks stages as on-disk evidence appears, and prefills from the latest manifest', async () => {
    const featureDir = writeFeatureConfig('checkout')
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'api.env'), 'PORT=0\n')
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), '{}')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'checkout.spec.ts'), '// spec\n')

    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const { body } = await entryFor('checkout')
    expect(body.flight).toMatchObject({ flightId, status: 'done' })
    expect(body.active).toBe(false)
    expect(body.canContinue).toBe(false)
    expect(body.prefill).toMatchObject({ repoPaths: [repoDir], description: 'checkout flow', env: 'local' })
    expect(stageOf(body, 'run').allowed).toBe(true)
    // No runId recorded on the flight links (stub adapters) → export blocked.
    expect(stageOf(body, 'evaluation-export').allowed).toBe(false)
    expect(stageOf(body, 'evaluation-export').reason).toMatch(/no passed run/)
  })

  it('flags an active flight (attach, don’t start) and continue for a paused one', async () => {
    writeFeatureConfig('checkout')
    // A plain `let` here gets narrowed to `never` by TS's control-flow
    // analysis after the `while` loop below, because the only assignment it
    // sees in this function's flow graph is the `null` initializer — the
    // reassignment inside the nested `run` closure lives in a separate flow
    // graph. Boxing it in an object sidesteps that narrowing.
    const gateBox: { gate: (() => void) | null } = { gate: null }
    let fail = true
    const adapters = allDone()
    adapters.docs = {
      run: async () => {
        await new Promise<void>((resolve) => { gateBox.gate = resolve })
        return fail ? { kind: 'failed', error: 'no docs' } : { kind: 'done' }
      },
    }
    app = await buildApp(adapters)
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    // The docs adapter parks on the gate — wait until the conductor reaches it
    // so "active" is observed mid-stage, not at the pre-drive instant.
    const deadline = Date.now() + 3000
    while (gateBox.gate === null) {
      if (Date.now() > deadline) throw new Error('docs adapter never started')
      await new Promise((r) => setTimeout(r, 10))
    }

    const whileActive = await entryFor('checkout')
    expect(whileActive.body.active).toBe(true)
    expect(whileActive.body.canContinue).toBe(false)

    gateBox.gate!()
    await waitForStatus(flightId, ['paused'])
    fail = false

    const whilePaused = await entryFor('checkout')
    expect(whilePaused.body.active).toBe(false)
    expect(whilePaused.body.canContinue).toBe(true)
    expect(whilePaused.body.flight).toMatchObject({ flightId, status: 'paused' })
  })
})

describe('POST /api/flights/:id/pause + /redo, frozen args, DELETE', () => {
  const hangingScout = (): StageAdapters => {
    const adapters = allDone()
    adapters.scout = { run: () => new Promise(() => {}) }
    return adapters
  }

  it('pause parks an active flight with pauseReason user; 409 on a settled one; 404 unknown', async () => {
    app = await buildApp(hangingScout())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['running'])

    const paused = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })
    expect(paused.statusCode).toBe(200)
    expect(paused.json()).toMatchObject({ status: 'paused', pauseReason: 'user' })

    const again = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/pause` })
    expect(again.statusCode).toBe(409)

    const unknown = await app.inject({ method: 'POST', url: '/api/flights/nope/pause' })
    expect(unknown.statusCode).toBe(404)
  })

  it('redo restarts the same record from stage 1 (201); 409 while active', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const redone = await app.inject({ method: 'POST', url: `/api/flights/${flightId}/redo` })
    expect(redone.statusCode).toBe(201)
    expect((redone.json() as { flightId: string }).flightId).toBe(flightId)
    await waitForStatus(flightId, ['done'])
  })

  it('R75: mid-pipeline re-entry keeps the freeze (409 flight_frozen); a full redo ACCEPTS new values', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    // Jump = partial re-entry → frozen, 409.
    const intentChange = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: startBody({ description: 'a different intent', mode: 'jump', fromStage: 'scout' }),
    })
    expect(intentChange.statusCode).toBe(409)
    expect(intentChange.json()).toMatchObject({ type: 'flight_frozen' })

    // Redo = full restart → new values accepted, replacing the stored ones.
    const redone = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: startBody({ description: 'a different intent', mode: 'redo' }),
    })
    expect(redone.statusCode).toBe(201)
    const body = redone.json() as { flightId: string; description: string }
    expect(body.flightId).toBe(flightId)
    expect(body.description).toBe('a different intent')
    await waitForStatus(flightId, ['done'])
  })

  it('a mode-carrying POST may omit repos + description — the stored values are reused', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const redone = await app.inject({
      method: 'POST',
      url: '/api/flights',
      body: { feature: 'checkout', mode: 'redo' },
    })
    expect(redone.statusCode).toBe(201)
    const body = redone.json() as { flightId: string; repoPaths: string[]; description: string }
    expect(body.flightId).toBe(flightId)
    expect(body.repoPaths).toEqual([repoDir])
    expect(body.description).toBe('checkout flow')
    await waitForStatus(flightId, ['done'])
  })

  it('DELETE removes a settled record (feature returns to not-flown); 409 while active; 404 unknown', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const flightId = (started.json() as { flightId: string }).flightId
    await waitForStatus(flightId, ['done'])

    const deleted = await app.inject({ method: 'DELETE', url: `/api/flights/${flightId}` })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ deleted: true })
    const list = await app.inject({ method: 'GET', url: '/api/flights' })
    expect((list.json() as { flights: unknown[] }).flights).toHaveLength(0)

    const unknown = await app.inject({ method: 'DELETE', url: `/api/flights/${flightId}` })
    expect(unknown.statusCode).toBe(404)

    const activeApp = await buildApp(hangingScout())
    const started2 = await activeApp.inject({ method: 'POST', url: '/api/flights', body: startBody() })
    const activeId = (started2.json() as { flightId: string }).flightId
    const whileActive = await activeApp.inject({ method: 'DELETE', url: `/api/flights/${activeId}` })
    expect(whileActive.statusCode).toBe(409)
    await activeApp.close()
  })
})

describe('GET /api/flights collapses to latest-per-feature (R67)', () => {
  it('pre-invariant duplicate records for one feature render as one row (the newest)', async () => {
    const store = new FlightRunStore(tmpDir)
    const stages = FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))
    const mk = (flightId: string, feature: string, createdAt: string): FlightManifest => ({
      flightId,
      feature,
      repoPaths: [repoDir],
      description: 'legacy',
      opts: { env: 'local', coverageTarget: 100, yolo: false },
      status: 'done',
      currentStage: null,
      stages: stages.map((s) => ({ ...s })),
      createdAt,
      updatedAt: createdAt,
    })
    // Saved oldest-first; list() is newest-first, so fl-legacy-3 is the keeper.
    store.save(mk('fl-legacy-1', 'first-flight-smoke', '2026-01-01T00:00:00Z'))
    store.save(mk('fl-legacy-2', 'first-flight-smoke', '2026-01-02T00:00:00Z'))
    store.save(mk('fl-legacy-3', 'first-flight-smoke', '2026-01-03T00:00:00Z'))
    store.save(mk('fl-other', 'other-feature', '2026-01-01T12:00:00Z'))

    app = await buildApp(allDone(), store)
    const res = await app.inject({ method: 'GET', url: '/api/flights' })
    const flights = (res.json() as { flights: Array<{ flightId: string; feature: string }> }).flights
    expect(flights).toHaveLength(2)
    expect(flights.find((f) => f.feature === 'first-flight-smoke')!.flightId).toBe('fl-legacy-3')
  })
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
      expect(noNameKey.json()).toMatchObject({ error: 'every feature needs a slug name and a description' })

      const noName = await app.inject({
        method: 'POST',
        url: `/api/flights/plan-features/${task.taskId}/launch`,
        body: { features: [{ name: '', description: 'has a description' }] },
      })
      expect(noName.statusCode).toBe(400)
      expect(noName.json()).toMatchObject({ error: 'every feature needs a slug name and a description' })

      const noDescription = await app.inject({
        method: 'POST',
        url: `/api/flights/plan-features/${task.taskId}/launch`,
        body: { features: [{ name: 'named-thing' }] },
      })
      expect(noDescription.statusCode).toBe(400)
      expect(noDescription.json()).toMatchObject({ error: 'every feature needs a slug name and a description' })
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
      expect(resp.json()).toMatchObject({ error: 'feature names must be unique' })
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
  it('normalizePlanResult rejects zero features, a missing description, and duplicate names', () => {
    expect(() => normalizePlanResult({ split: false, features: [] })).toThrow(/no features/)
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
    ).toThrow(/duplicate feature names/)
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

describe('flight agent (R79)', () => {
  it('agent rides the start body into the manifest opts (invalid values dropped)', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ agent: 'codex' }) })
    expect(started.statusCode).toBe(201)
    expect((started.json() as { opts: { agent?: string } }).opts.agent).toBe('codex')

    await waitForStatus((started.json() as { flightId: string }).flightId, ['done'])
    const otherRepo = path.join(path.dirname(repoDir), 'product-repo-b')
    fs.mkdirSync(otherRepo, { recursive: true })
    const other = await app.inject({
      method: 'POST', url: '/api/flights',
      body: startBody({ feature: 'other', repoPaths: [otherRepo], agent: 'gpt-oss' }),
    })
    expect(other.statusCode).toBe(201)
    expect((other.json() as { opts: { agent?: string } }).opts.agent).toBeUndefined()
  })
})
