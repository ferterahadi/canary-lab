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

  it('carries autopilot:false from the start payload into the flight options', async () => {
    app = await buildApp(allDone())
    const started = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ autopilot: false, agent: 'codex' }) })
    expect(started.statusCode).toBe(201)
    expect((started.json() as { opts: { autopilot?: boolean; agent?: string } }).opts).toMatchObject({ autopilot: false, agent: 'codex' })
  })

  it('carries stageProducer into the flight options, and drops an unknown value', async () => {
    app = await buildApp(allDone())
    const external = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ stageProducer: 'external' }) })
    expect(external.statusCode).toBe(201)
    expect((external.json() as { opts: { stageProducer?: string } }).opts.stageProducer).toBe('external')

    // Unknown values DEGRADE to the internal default rather than 400 — same
    // posture as `agent`, so an older client sending nonsense still starts a
    // flight instead of failing at the door.
    app = await buildApp(allDone())
    const bogus = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ feature: 'other', stageProducer: 'sampling' }) })
    expect(bogus.statusCode).toBe(201)
    expect('stageProducer' in (bogus.json() as { opts: Record<string, unknown> }).opts).toBe(false)
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
})
