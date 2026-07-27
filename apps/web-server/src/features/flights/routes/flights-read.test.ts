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
    // Config on disk → every stage whose only dependency is the suite existing is
    // enterable with no flight record at all. `docs` and `prd-summary` belong here:
    // they gather and distil requirement files and boot nothing, so an envset is
    // not their prerequisite (the old positional rule wrongly demanded one).
    for (const key of ['similarity', 'scout', 'scaffold', 'env-capture', 'docs', 'prd-summary'] as const) {
      expect(stageOf(body, key)).toMatchObject({ allowed: true })
    }
    // Stages that DO read the envset stay blocked, named by the missing artifact —
    // the validator, not a record check.
    for (const key of ['specs-coverage', 'portify', 'run'] as const) {
      expect(stageOf(body, key)).toMatchObject({ allowed: false })
      expect(stageOf(body, key).reason).toMatch(/env-capture prerequisite/)
      expect(stageOf(body, key).reason).not.toMatch(/first flight/)
    }
    // The export builds its archive from the run record, so its blocker is the
    // absent run — never someone else's missing artifact.
    expect(stageOf(body, 'evaluation-export')).toMatchObject({ allowed: false })
    expect(stageOf(body, 'evaluation-export').reason).toMatch(/run prerequisite/)
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
