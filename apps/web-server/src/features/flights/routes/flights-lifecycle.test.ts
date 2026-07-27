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

  // A stage is gated on what it READS, never on list position. The run stage
  // executes specs — it never opens the PRD summary — so a suite with config,
  // envset and specs is enterable at `run` with no requirements on disk at all.
  // The old positional rule rejected this, which left a suite holding a green run
  // unable to re-enter the very stage that produced it.
  it('allows a jump to run with no PRD summary — the run stage never reads one', async () => {
    const featureDir = path.join(tmpDir, 'features', 'checkout')
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'api.env'), 'PORT=0\n')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'checkout.spec.ts'), '')
    expect(fs.existsSync(path.join(featureDir, 'docs', '_prd-summary.json'))).toBe(false)
    app = await buildApp(allDone())
    const jump = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ fromStage: 'run' }) })
    expect(jump.statusCode).toBe(201)
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

  // The archive is built from the run record, so a settled run is the ONLY thing
  // the export reads. Under the old positional rule it inherited the whole
  // requirements-and-specs chain, which meant a suite holding a passing run could
  // not export the report it had already earned.
  it('allows a jump to the evaluation export on a passed run alone — no PRD, no specs', async () => {
    const featureDir = path.join(tmpDir, 'features', 'checkout')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'module.exports = {}\n')
    fs.mkdirSync(path.join(tmpDir, 'runs'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'runs', 'index.json'),
      JSON.stringify([{ runId: '2026-07-01T0245-o456', feature: 'checkout', startedAt: '2026-07-01T02:45:00.000Z', status: 'passed' }]),
    )
    expect(fs.existsSync(path.join(featureDir, 'docs', '_prd-summary.json'))).toBe(false)
    expect(fs.existsSync(path.join(featureDir, 'e2e'))).toBe(false)
    app = await buildApp(allDone())
    const jump = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ fromStage: 'evaluation-export' }) })
    expect(jump.statusCode).toBe(201)
  })

  it('still refuses the evaluation export when the feature has no settled run', async () => {
    const featureDir = path.join(tmpDir, 'features', 'checkout')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'module.exports = {}\n')
    app = await buildApp(allDone())
    const jump = await app.inject({ method: 'POST', url: '/api/flights', body: startBody({ fromStage: 'evaluation-export' }) })
    expect(jump.statusCode).toBe(400)
    const body = jump.json() as { type: string; error: string }
    expect(body.type).toBe('stage_entry_rejected')
    expect(body.error).toMatch(/run prerequisite/)
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
