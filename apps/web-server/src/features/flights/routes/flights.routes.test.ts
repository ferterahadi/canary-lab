import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { flightsRoutes } from './flights'
import { FlightRunStore } from '../logic/store'
import type { StageAdapters } from '../logic/conductor'
import { FLIGHT_STAGE_KEYS } from '../logic/types'

let tmpDir: string
let repoDir: string
let app: FastifyInstance

function allDone(): StageAdapters {
  return Object.fromEntries(
    FLIGHT_STAGE_KEYS.map((k) => [k, { run: async () => ({ kind: 'done' as const }) }]),
  ) as StageAdapters
}

async function buildApp(adapters: StageAdapters): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false })
  await instance.register(flightsRoutes, {
    featuresDir: path.join(tmpDir, 'features'),
    logsDir: tmpDir,
    projectRoot: tmpDir,
    adapters,
    flightStore: new FlightRunStore(tmpDir),
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
})
