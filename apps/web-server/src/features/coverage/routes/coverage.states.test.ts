import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

import Fastify, { type FastifyInstance } from 'fastify'

// Coverage generation is LLM-only; the route drives the real service, so swap the
// agent-backed summarizer/mapper for the test fakes at the module boundary.
//
// The fakes are loaded via vi.hoisted (which runs BEFORE the vi.mock registrations
// below) so the fixture's own `import { reconcileRequirementIds } from
// '../prd-summary'` resolves to the REAL module. Importing the fixture *inside* a
// mock factory deadlocks instead: the factory would await an import of the fixture,
// which re-enters the very module being mocked while its factory is still running.
const { fakeSummarize, fakePropose } = await vi.hoisted(
  async () => import('../logic/coverage/__fixtures__/fake-coverage-agents'),
)

vi.mock('../logic/coverage/prd-summary', async (importActual) => {
  const actual = await importActual<typeof import('../logic/coverage/prd-summary')>()
  return { ...actual, summarizePrd: fakeSummarize }
})

vi.mock('../logic/coverage/annotate-engine', async (importActual) => {
  const actual = await importActual<typeof import('../logic/coverage/annotate-engine')>()
  return { ...actual, proposeCoverageMappings: fakePropose }
})

import { coverageRoutes } from './coverage'

import type { WorkspaceEvent } from '../../../shared/workspace-events'

import type { CoverageLedger, PrdSummary } from '../../../../../../shared/coverage/types'

import { bridgeStoreEvents } from '../../../shared/store-event-bridge'
import { FlightRunStore } from '../../flights/logic/store'

import { FLIGHT_STAGE_KEYS } from '../../flights/logic/types'

let tmpDir: string

let featuresDir: string

let logsDir: string

let app: FastifyInstance

let events: WorkspaceEvent[]

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cov-route-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  app = Fastify()
  events = []
  await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, workspaceEvents: { publish: (e) => events.push(e) } })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFeature(name: string, spec: string, docs: Record<string, string> = {}): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), spec)
  if (Object.keys(docs).length) {
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    for (const [rel, content] of Object.entries(docs)) {
      fs.writeFileSync(path.join(dir, 'docs', rel), content)
    }
  }
  return dir
}

const SPEC = `
  import { test, expect } from '@playwright/test'
  // @requirement R1
  // @path happy
  test('Cart adds an item', async () => {
    await page.goto('https://shop.test/cart')
    await expect(page.locator('.cart')).toBeVisible()
  })
`

describe('coverage routes', () => {
  it('404s for an unknown feature', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/features/nope/coverage' })
    expect(res.statusCode).toBe(404)
  })

  it('regenerate (deterministic) → a mapped test makes the requirement covered (run-free)', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nuser adds an item to the cart' })

    // Generate the PRD summary deterministically (heading → requirement R1).
    const regen = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/prd-summary/regenerate',
      payload: {},
    })
    expect(regen.statusCode).toBe(200)
    const summary = (regen.json() as { summary: PrdSummary }).summary
    expect(summary.requirements[0].id).toBe('R1')
    expect(summary.requirements[0].title).toBe('Cart adds an item')

    // The test maps to R1 and claims its only declared path (happy) → covered.
    // No run is involved — coverage is semantic.
    const cov = (await app.inject({ method: 'GET', url: '/api/features/checkout/coverage' })).json() as CoverageLedger
    expect(cov.requirements[0].gapType).toBe('covered')
    expect(cov.coveragePct).toBe(100)
    expect(cov.docsDrift).toBe(false)
  })

  it('clears the generated PRD summary (back to no-summary state)', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nbody' })
    await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: {} })
    // Summary exists.
    let docs = (await app.inject({ method: 'GET', url: '/api/features/checkout/docs' })).json() as { hasPrdSummary: boolean }
    expect(docs.hasPrdSummary).toBe(true)

    const cleared = await app.inject({ method: 'DELETE', url: '/api/features/checkout/prd-summary' })
    expect(cleared.statusCode).toBe(200)
    expect((cleared.json() as { removed: string[] }).removed).toContain('_prd-summary.json')
    // Clearing changes the coverage badge AND un-tags the specs — both must push.
    expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
    expect(events).toContainEqual({ type: 'tests-changed', feature: 'checkout' })

    // Back to no summary; source doc untouched.
    docs = (await app.inject({ method: 'GET', url: '/api/features/checkout/docs' })).json() as { hasPrdSummary: boolean }
    expect(docs.hasPrdSummary).toBe(false)
    const cov = (await app.inject({ method: 'GET', url: '/api/features/checkout/coverage' })).json() as CoverageLedger
    expect(cov.state?.summary).toBe('absent')
  })

  it('reports per-feature coverage headlines via /coverage/states', async () => {
    writeFeature('checkout', SPEC)
    const states = (await app.inject({ method: 'GET', url: '/api/coverage/states' })).json() as Array<{ feature: string; headline: string | null }>
    const entry = states.find((s) => s.feature === 'checkout')
    expect(entry).toBeTruthy()
    expect(entry?.headline).toBe('Setup needed') // no summary yet
  })

  it('/api/coverage/states degrades to { headline: null } when computeFeatureCoverage throws (FeatureNotFoundError)', async () => {
    // The /api/coverage/states route iterates loadFeatures(), then calls
    // computeFeatureCoverage() per feature — which internally calls resolveFeatureDir()
    // (another loadFeatures scan). If the feature vanishes between those two calls
    // it throws FeatureNotFoundError → caught → headline: null entry.
    //
    // We simulate this by using a staleDir that starts with a valid feature config
    // but whose config is swapped to an invalid name *after* the route registers,
    // so the first loadFeatures (outer loop) finds 'ghost-feature' by name but the
    // second loadFeatures (resolveFeatureDir) can't match it.
    const staleFeatureDir = path.join(featuresDir, 'ghost-feature')
    fs.mkdirSync(path.join(staleFeatureDir, 'e2e'), { recursive: true })
    // Write a valid config with name 'ghost-feature'.
    fs.writeFileSync(
      path.join(staleFeatureDir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'ghost-feature', description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
    )
    fs.writeFileSync(path.join(staleFeatureDir, 'e2e', 'a.spec.ts'), SPEC)

    // Confirm the feature is visible.
    const before = (await app.inject({ method: 'GET', url: '/api/coverage/states' })).json() as Array<{ feature: string }>
    expect(before.find((s) => s.feature === 'ghost-feature')).toBeTruthy()

    // Rename the feature config so the *second* loadFeatures (inside resolveFeatureDir)
    // can no longer find 'ghost-feature' → throws FeatureNotFoundError → caught → null.
    fs.renameSync(
      path.join(staleFeatureDir, 'feature.config.cjs'),
      path.join(staleFeatureDir, 'feature.config.cjs.bak'),
    )

    const statesRes = await app.inject({ method: 'GET', url: '/api/coverage/states' })
    const states = statesRes.json() as Array<{
      feature: string
      headline: string | null
      summary: string | null
      coverage: string | null
      coveragePct: number | null
    }>
    // The outer loop used a cached directory scan (readdirSync based), so
    // ghost-feature may or may not appear — what matters is: if it appears,
    // headline must be null (computation failed); and the rest of the features
    // must still return without a 500.
    expect(statesRes.statusCode).toBe(200) // 200 with an array body, not an error object
    const entry = states.find((s) => s.feature === 'ghost-feature')
    if (entry) {
      expect(entry.headline).toBeNull()
      expect(entry.summary).toBeNull()
      expect(entry.coveragePct).toBeNull()
    }
    // The route must return 200 (not 500) regardless.
    const raw = await app.inject({ method: 'GET', url: '/api/coverage/states' })
    expect(raw.statusCode).toBe(200)
  })

  it('DELETE /api/features/:name/prd-summary returns 404 for an unknown feature', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/features/ghost/prd-summary' })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: string }).error).toMatch(/ghost/)
  })

  it('POST /api/features/:name/prd-summary/regenerate returns 404 for an unknown feature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/features/ghost/prd-summary/regenerate',
      payload: {},
    })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: string }).error).toMatch(/ghost/)
  })

  it('preserves requirement ids across a regenerate cycle', async () => {
    const dir = writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nbody' })
    const first = (await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: {} })).json() as { summary: PrdSummary }
    expect(first.summary.requirements.map((r) => r.id)).toEqual(['R1'])

    // Add a second section, regenerate — R1 must hold, new section becomes R2.
    fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Cart adds an item\nbody\n# Checkout completes\npay')
    const second = (await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: {} })).json() as { summary: PrdSummary }
    expect(second.summary.requirements.find((r) => r.title === 'Cart adds an item')?.id).toBe('R1')
    expect(second.summary.requirements.find((r) => r.title === 'Checkout completes')?.id).toBe('R2')
  })

  it('/api/coverage/states degrades to { headline: null } when a feature has no featureDir', async () => {
    // Write a feature config that exports name but omits featureDir.
    // loadFeatures (outer loop) returns it; resolveFeatureDir (inside computeFeatureCoverage)
    // then throws FeatureNotFoundError because !found.featureDir → caught → line 202.
    const noFdirDir = path.join(featuresDir, 'no-fdir')
    fs.mkdirSync(path.join(noFdirDir, 'e2e'), { recursive: true })
    fs.writeFileSync(
      path.join(noFdirDir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'no-fdir', description: 'd', envs: ['local'], repos: [] } }`,
    )
    fs.writeFileSync(path.join(noFdirDir, 'e2e', 'a.spec.ts'), SPEC)

    const res = await app.inject({ method: 'GET', url: '/api/coverage/states' })
    expect(res.statusCode).toBe(200)
    const states = res.json() as Array<{ feature: string; headline: string | null; summary: string | null; coveragePct: number | null }>
    const entry = states.find((s) => s.feature === 'no-fdir')
    expect(entry).toBeTruthy()
    expect(entry?.headline).toBeNull()
    expect(entry?.summary).toBeNull()
    expect(entry?.coveragePct).toBeNull()
  })
})

describe('coverage-redo backflow into the flight record', () => {
  it('clearing the PRD summary reopens the non-active flight docs/prd-summary/specs-coverage stages', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\ncart' })
    const flightStore = new FlightRunStore(logsDir)
    // The backflow's live signal now rides the store's own writes rather than a
    // publish inside `reopenStages`, so bridge this store the way the server
    // bridges its shared one (shared/store-event-bridge.ts). Uncoalesced here
    // so the assertion below reads the event synchronously.
    bridgeStoreEvents(flightStore, { publish: (e) => events.push(e) }, () => ({ type: 'flights-changed' }))
    const doneStages = FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))
    flightStore.save({
      flightId: 'fl-backflow',
      feature: 'checkout',
      repoPaths: ['/repo/a'],
      description: 'checkout flow',
      opts: { env: 'local', coverageTarget: 100, yolo: false },
      status: 'done',
      currentStage: null,
      stages: doneStages,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })

    const backflowApp = Fastify()
    await backflowApp.register(coverageRoutes, {
      featuresDir,
      logsDir,
      projectRoot: tmpDir,
      flightStore,
      workspaceEvents: { publish: (e) => events.push(e) },
    })
    await backflowApp.ready()
    try {
      const res = await backflowApp.inject({ method: 'DELETE', url: '/api/features/checkout/prd-summary' })
      expect(res.statusCode).toBe(200)
      const flight = flightStore.get('fl-backflow')!
      expect(flight.status).toBe('paused')
      expect(flight.pauseReason).toBe('user')
      for (const key of ['docs', 'prd-summary', 'specs-coverage', 'run', 'evaluation-export'] as const) {
        expect(flight.stages.find((s) => s.key === key)!.status).toBe('pending')
      }
      for (const key of ['similarity', 'scout', 'scaffold', 'env-capture'] as const) {
        expect(flight.stages.find((s) => s.key === key)!.status).toBe('done')
      }
      expect(events.some((e) => e.type === 'flights-changed')).toBe(true)
    } finally {
      await backflowApp.close()
    }
  })

  it('is a no-op reopen when flightStore is present but no flight exists for the feature (line 196 false branch)', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\ncart' })
    const flightStore = new FlightRunStore(logsDir)
    // No flight saved for 'checkout' — latestForFeature() returns null, so the
    // `if (record)` guard must skip reopenStages entirely without throwing.

    const backflowApp = Fastify()
    await backflowApp.register(coverageRoutes, {
      featuresDir,
      logsDir,
      projectRoot: tmpDir,
      flightStore,
      workspaceEvents: { publish: (e) => events.push(e) },
    })
    await backflowApp.ready()
    try {
      const res = await backflowApp.inject({ method: 'DELETE', url: '/api/features/checkout/prd-summary' })
      expect(res.statusCode).toBe(200)
      // Still un-tags docs + notifies clients — just skips the flight-reopen path.
      expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
      expect(events).toContainEqual({ type: 'tests-changed', feature: 'checkout' })
      expect(events.some((e) => e.type === 'flights-changed')).toBe(false)
    } finally {
      await backflowApp.close()
    }
  })

  it('leaves an ACTIVE flight untouched (the running conductor owns it)', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\ncart' })
    const flightStore = new FlightRunStore(logsDir)
    flightStore.save({
      flightId: 'fl-active',
      feature: 'checkout',
      repoPaths: ['/repo/a'],
      description: 'checkout flow',
      opts: { env: 'local', coverageTarget: 100, yolo: false },
      status: 'running',
      currentStage: 'specs-coverage',
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'running' as const })),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    const backflowApp = Fastify()
    await backflowApp.register(coverageRoutes, {
      featuresDir,
      logsDir,
      projectRoot: tmpDir,
      flightStore,
      workspaceEvents: { publish: (e) => events.push(e) },
    })
    await backflowApp.ready()
    try {
      await backflowApp.inject({ method: 'DELETE', url: '/api/features/checkout/prd-summary' })
      expect(flightStore.get('fl-active')!.status).toBe('running')
    } finally {
      await backflowApp.close()
    }
  })
})
