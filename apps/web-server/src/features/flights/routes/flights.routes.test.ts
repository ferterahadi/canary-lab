import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { flightsRoutes } from './flights'
import { FlightRunStore, type FlightStore, type FlightStoreEvent } from '../logic/store'
import type { StageAdapters } from '../logic/conductor'
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

async function buildApp(adapters: StageAdapters, flightStore?: FlightStore): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false })
  await instance.register(flightsRoutes, {
    featuresDir: path.join(tmpDir, 'features'),
    logsDir: tmpDir,
    projectRoot: tmpDir,
    adapters,
    ...(flightStore ? { flightStore } : {}),
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
})
