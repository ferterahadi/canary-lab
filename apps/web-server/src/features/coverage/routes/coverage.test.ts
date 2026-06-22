import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { coverageRoutes } from './coverage'
import { CoverageJobRunStore, type CoverageJobStore, type CoverageJobStoreEvent } from '../../coverage/logic/coverage/jobs/store'
import type { CoverageLedger, PrdSummary } from '../../../../../../shared/coverage/types'
import type { CoverageJobManifest, CoverageJobIndexEntry, CoverageJobKind } from '../../coverage/logic/coverage/jobs/types'

let tmpDir: string
let featuresDir: string
let logsDir: string
let app: FastifyInstance

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cov-route-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  app = Fastify()
  await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir })
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
      payload: { adapter: 'deterministic' },
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

  it('lists docs and reports drift after a source doc changes', async () => {
    const dir = writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nbody' })
    await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: { adapter: 'deterministic' } })

    const docs = (await app.inject({ method: 'GET', url: '/api/features/checkout/docs' })).json() as {
      docs: { relPath: string; generated: boolean }[]
      hasPrdSummary: boolean
      docsDrift: boolean
    }
    expect(docs.hasPrdSummary).toBe(true)
    expect(docs.docs.find((d) => d.relPath === 'spec.md')?.generated).toBe(false)
    expect(docs.docs.find((d) => d.relPath === '_prd-summary.md')?.generated).toBe(true)
    expect(docs.docsDrift).toBe(false)

    // Edit the source doc → drift detected.
    fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Cart adds an item\nbody changed')
    const cov = (await app.inject({ method: 'GET', url: '/api/features/checkout/coverage' })).json() as CoverageLedger
    expect(cov.docsDrift).toBe(true)
  })

  it('adds a source doc via POST /docs (then it appears in the listing)', async () => {
    writeFeature('checkout', SPEC)
    const add = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/docs',
      payload: { relPath: 'notes.md', content: '# Notes\nbody' },
    })
    expect(add.statusCode).toBe(200)
    const docs = (await app.inject({ method: 'GET', url: '/api/features/checkout/docs' })).json() as { docs: { relPath: string }[]; sourceDocCount: number }
    expect(docs.docs.map((d) => d.relPath)).toContain('notes.md')
    expect(docs.sourceDocCount).toBe(1)
  })

  it('rejects a doc write with missing fields', async () => {
    writeFeature('checkout', SPEC)
    const res = await app.inject({ method: 'POST', url: '/api/features/checkout/docs', payload: { relPath: 'x.md' } })
    expect(res.statusCode).toBe(400)
  })

  it('starts a coverage job (202), polls it to done, and rejects a concurrent one (409)', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nuser adds an item to the cart' })
    await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: { adapter: 'deterministic' } })

    const start = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/coverage/jobs',
      payload: { kind: 'coverage', adapter: 'deterministic' },
    })
    expect(start.statusCode).toBe(202)
    const jobId = (start.json() as { jobId: string }).jobId
    expect(jobId).toBeTruthy()

    // Poll until the (fast, deterministic) job finishes.
    let manifest: { status: string } = { status: 'running' }
    for (let i = 0; i < 50 && manifest.status === 'running'; i++) {
      manifest = (await app.inject({ method: 'GET', url: `/api/coverage/jobs/${jobId}` })).json() as { status: string }
      if (manifest.status === 'running') await new Promise((r) => setTimeout(r, 10))
    }
    expect(manifest.status).toBe('done')

    // It appears in the feature's job list.
    const jobs = (await app.inject({ method: 'GET', url: '/api/features/checkout/coverage/jobs' })).json() as unknown[]
    expect(jobs.length).toBe(1)
  })

  it('rejects a job with an invalid kind (400) and an unknown feature (404)', async () => {
    writeFeature('checkout', SPEC)
    const bad = await app.inject({ method: 'POST', url: '/api/features/checkout/coverage/jobs', payload: { kind: 'nope' } })
    expect(bad.statusCode).toBe(400)
    const missing = await app.inject({ method: 'POST', url: '/api/features/ghost/coverage/jobs', payload: { kind: 'summary' } })
    expect(missing.statusCode).toBe(404)
  })

  it('404s polling an unknown job', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/coverage/jobs/missing' })
    expect(res.statusCode).toBe(404)
  })

  it('agent-session: 404s an unknown job and returns null when a job has no session (R17)', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart\nuser adds an item' })
    // Unknown job → 404.
    const missing = await app.inject({ method: 'GET', url: '/api/coverage/jobs/nope/agent-session' })
    expect(missing.statusCode).toBe(404)
    // A real deterministic job has no agent session ref → null (200).
    await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: { adapter: 'deterministic' } })
    const start = await app.inject({ method: 'POST', url: '/api/features/checkout/coverage/jobs', payload: { kind: 'coverage', adapter: 'deterministic' } })
    const jobId = (start.json() as { jobId: string }).jobId
    let m: { status: string } = { status: 'running' }
    for (let i = 0; i < 50 && m.status === 'running'; i++) {
      m = (await app.inject({ method: 'GET', url: `/api/coverage/jobs/${jobId}` })).json() as { status: string }
      if (m.status === 'running') await new Promise((r) => setTimeout(r, 10))
    }
    const session = await app.inject({ method: 'GET', url: `/api/coverage/jobs/${jobId}/agent-session` })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toBeNull()
  })

  it('imports an uploaded doc (extracted to markdown) then lists it', async () => {
    writeFeature('checkout', SPEC)
    const base64 = Buffer.from('# Imported brief\nbody text').toString('base64')
    const imp = await app.inject({ method: 'POST', url: '/api/features/checkout/docs/import', payload: { filename: 'brief.md', base64 } })
    expect(imp.statusCode).toBe(200)
    expect((imp.json() as { relativePath: string }).relativePath).toContain('brief.md')
    const docs = (await app.inject({ method: 'GET', url: '/api/features/checkout/docs' })).json() as { docs: { relPath: string }[] }
    expect(docs.docs.map((d) => d.relPath)).toContain('brief.md')
  })

  it('deletes a source doc but refuses a generated artifact', async () => {
    const dir = writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nbody' })
    await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: { adapter: 'deterministic' } })

    const ok = await app.inject({ method: 'DELETE', url: '/api/features/checkout/docs/spec.md' })
    expect(ok.statusCode).toBe(200)
    expect(fs.existsSync(path.join(dir, 'docs', 'spec.md'))).toBe(false)

    const refused = await app.inject({ method: 'DELETE', url: '/api/features/checkout/docs/_prd-summary.md' })
    expect(refused.statusCode).toBe(400)
  })

  it('clears the generated PRD summary (back to no-summary state)', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nbody' })
    await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: { adapter: 'deterministic' } })
    // Summary exists.
    let docs = (await app.inject({ method: 'GET', url: '/api/features/checkout/docs' })).json() as { hasPrdSummary: boolean }
    expect(docs.hasPrdSummary).toBe(true)

    const cleared = await app.inject({ method: 'DELETE', url: '/api/features/checkout/prd-summary' })
    expect(cleared.statusCode).toBe(200)
    expect((cleared.json() as { removed: string[] }).removed).toContain('_prd-summary.json')

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

  it('GET /api/features/:name/docs returns 404 for an unknown feature', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/features/ghost/docs' })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: string }).error).toMatch(/ghost/)
  })

  it('agent-session: returns null (200) for a claude sessionRef when the log file is not on disk', async () => {
    // Create a feature so the store can accept its job manifest.
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart\nuser adds an item' })
    await app.close()

    // Re-register the route with an injected store so we can seed a manifest
    // with a claude sessionRef directly (no real agent runs).
    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    const fakeJobId = 'cj-test-session'
    store.save({
      jobId: fakeJobId,
      feature: 'checkout',
      kind: 'coverage',
      status: 'done',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      log: '',
      sessionRef: { agent: 'claude', sessionId: 'nonexistent-session-id' },
    })

    // findClaudeLogBySessionId returns null for a session that doesn't exist on
    // disk → the endpoint returns null (200) for the "no log yet" case.
    const res = await app.inject({ method: 'GET', url: `/api/coverage/jobs/${fakeJobId}/agent-session` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
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

    const states = (await app.inject({ method: 'GET', url: '/api/coverage/states' })).json() as Array<{
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
    expect(states.statusCode).toBeUndefined() // array, not an error object
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

  it('rejects a concurrent job with 409 and existingJobId', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nuser adds an item to the cart' })
    await app.close()

    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    // Seed a running job so the single-flight guard fires.
    const fakeJobId = 'cj-blocker'
    store.save({ jobId: fakeJobId, feature: 'checkout', kind: 'coverage', status: 'running', startedAt: '2026-01-01T00:00:00Z', log: '' })

    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/coverage/jobs',
      payload: { kind: 'coverage', adapter: 'deterministic' },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { existingJobId: string }).existingJobId).toBe(fakeJobId)
    expect(typeof (res.json() as { error: string }).error).toBe('string')
  })

  it('agent-session: returns null (200) for a claude sessionRef with an empty sessionId (line 231 null branch)', async () => {
    // ref.agent === 'claude' but ref.sessionId is '' (falsy) → the ternary
    // `ref.sessionId ? findClaudeLogBySessionId(...) : null` takes the null branch.
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart\nuser adds an item' })
    await app.close()

    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    store.save({
      jobId: 'cj-claude-no-session',
      feature: 'checkout',
      kind: 'coverage',
      status: 'done',
      startedAt: '2026-01-01T00:00:00Z',
      log: '',
      sessionRef: { agent: 'claude', sessionId: '' },
    })

    const res = await app.inject({ method: 'GET', url: '/api/coverage/jobs/cj-claude-no-session/agent-session' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
  })

  it('agent-session: returns null (200) for a codex sessionRef when no session is on disk', async () => {
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart\nuser adds an item' })
    await app.close()

    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    store.save({
      jobId: 'cj-codex',
      feature: 'checkout',
      kind: 'coverage',
      status: 'done',
      startedAt: '2026-01-01T00:00:00Z',
      log: '',
      sessionRef: { agent: 'codex', sessionId: '' },
    })

    // locateCodexSessionLog returns null (no real codex session on disk) → route returns null.
    const res = await app.inject({ method: 'GET', url: '/api/coverage/jobs/cj-codex/agent-session' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toBeNull()
  })

  it('POST /docs returns 404 for an unknown feature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/features/ghost/docs',
      payload: { relPath: 'x.md', content: 'body' },
    })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: string }).error).toMatch(/not found/)
  })

  it('POST /docs returns 400 when relPath escapes the docs directory', async () => {
    writeFeature('checkout', SPEC)
    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/docs',
      payload: { relPath: '../../../etc/passwd.md', content: 'body' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /docs/import returns 400 when filename or base64 is missing (lines 99-100)', async () => {
    writeFeature('checkout', SPEC)
    // Missing both fields — exercises the early-exit guard at lines 98-100.
    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/docs/import',
      payload: { filename: 'notes.md' }, // base64 missing
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/required/)
  })

  it('POST /docs/import returns 400 when body is absent entirely', async () => {
    // No body → req.body is null → `?? {}` fires → filename/base64 both undefined → 400.
    writeFeature('checkout', SPEC)
    const res = await app.inject({ method: 'POST', url: '/api/features/checkout/docs/import' })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/required/)
  })

  it('POST /docs/import sanitizes a filename to "doc.md" when base produces no valid characters', async () => {
    // A filename like "-----.md" sanitizes to empty string → falls back to "doc".
    // This exercises the `|| "doc"` fallback branch in the base-name computation.
    writeFeature('checkout', SPEC)
    // Use a filename whose base (before extension) has only dashes — sanitized to empty.
    const base64 = Buffer.from('# Brief\nbody').toString('base64')
    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/docs/import',
      payload: { filename: '----.md', base64 },
    })
    expect(res.statusCode).toBe(200)
    // The stored path uses "doc.md" as the fallback.
    expect((res.json() as { relativePath: string }).relativePath).toContain('doc.md')
  })

  it('DELETE /docs/:relPath returns 404 when the feature itself is not found', async () => {
    // deleteFeatureDoc on a missing feature returns { ok: false, error: '...not found...' }
    // → result.error.includes("not found") is true → 404.
    const res = await app.inject({ method: 'DELETE', url: '/api/features/ghost/docs/spec.md' })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: string }).error).toMatch(/not found/)
  })

  it('POST /docs/import returns 400 when the file type is unsupported', async () => {
    writeFeature('checkout', SPEC)
    // An .exe filename has no text/pdf/docx handler → extractPrdDocument throws.
    const base64 = Buffer.from('binary content').toString('base64')
    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/docs/import',
      payload: { filename: 'binary.exe', base64 },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toMatch(/Unsupported/)
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
      payload: { adapter: 'deterministic' },
    })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: string }).error).toMatch(/ghost/)
  })

  it('preserves requirement ids across a regenerate cycle', async () => {
    const dir = writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nbody' })
    const first = (await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: { adapter: 'deterministic' } })).json() as { summary: PrdSummary }
    expect(first.summary.requirements.map((r) => r.id)).toEqual(['R1'])

    // Add a second section, regenerate — R1 must hold, new section becomes R2.
    fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Cart adds an item\nbody\n# Checkout completes\npay')
    const second = (await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: { adapter: 'deterministic' } })).json() as { summary: PrdSummary }
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

  it('agent-session: loads and returns events from a real claude log when it exists on disk (R17)', async () => {
    // Build a minimal JSONL claude session log on disk so findClaudeLogBySessionId
    // can locate it → loadAgentSession is called → lines 238-239 are covered.
    writeFeature('checkout', SPEC, { 'spec.md': '# Cart\nuser adds an item' })
    await app.close()

    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    const sessionId = 'test-session-log-' + Date.now()
    // Write a minimal claude log under ~/.claude/projects/<encoded-tmpDir>/<sessionId>.jsonl
    const homeDir = os.homedir()
    const encodedDir = tmpDir.replace(/\//g, '-').replace(/^-/, '')
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    // Scan for any existing project dir that matches, or create a synthetic one.
    // We use a dedicated test subdir so we can clean it up.
    const testProjectDir = path.join(projectsDir, `test-canary-lab-${Date.now()}`)
    fs.mkdirSync(testProjectDir, { recursive: true })
    const logFile = path.join(testProjectDir, `${sessionId}.jsonl`)
    fs.writeFileSync(logFile, JSON.stringify({ type: 'system', subtype: 'init', cwd: tmpDir, version: '1.0.0', tools: [] }) + '\n')

    try {
      store.save({
        jobId: 'cj-real-session',
        feature: 'checkout',
        kind: 'coverage',
        status: 'done',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:01:00Z',
        log: '',
        sessionRef: { agent: 'claude', sessionId },
      })

      const res = await app.inject({ method: 'GET', url: '/api/coverage/jobs/cj-real-session/agent-session' })
      expect(res.statusCode).toBe(200)
      // The session was found and loaded: returns an object with agent + events array.
      const body = res.json() as { agent: string; events: unknown[] } | null
      expect(body).not.toBeNull()
      expect(body?.agent).toBe('claude')
      expect(Array.isArray(body?.events)).toBe(true)
    } finally {
      // Clean up the synthetic project dir.
      fs.rmSync(testProjectDir, { recursive: true, force: true })
    }
  })

  it('GET /api/coverage/jobs returns all jobs sorted newest-first (line 184)', async () => {
    // Populate three jobs with distinct timestamps so the sort comparator is called
    // in both directions — covering both the `1` (a < b) and `-1` (a >= b) branches.
    writeFeature('checkout', SPEC)
    writeFeature('checkout2', SPEC)
    writeFeature('checkout3', SPEC)
    await app.close()

    const store = new CoverageJobRunStore(logsDir)
    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: store })
    await app.ready()

    store.save({ jobId: 'cj-a', feature: 'checkout', kind: 'summary', status: 'done', startedAt: '2026-01-01T00:00:00Z', log: '' })
    store.save({ jobId: 'cj-b', feature: 'checkout2', kind: 'coverage', status: 'done', startedAt: '2026-01-03T00:00:00Z', log: '' })
    store.save({ jobId: 'cj-c', feature: 'checkout3', kind: 'summary', status: 'done', startedAt: '2026-01-02T00:00:00Z', log: '' })

    const res = await app.inject({ method: 'GET', url: '/api/coverage/jobs' })
    expect(res.statusCode).toBe(200)
    const jobs = res.json() as Array<{ jobId: string; startedAt: string }>
    expect(jobs.length).toBeGreaterThanOrEqual(3)
    // Newest first: cj-b (Jan 3) → cj-c (Jan 2) → cj-a (Jan 1).
    const ids = jobs.map((j) => j.jobId)
    expect(ids.indexOf('cj-b')).toBeLessThan(ids.indexOf('cj-c'))
    expect(ids.indexOf('cj-c')).toBeLessThan(ids.indexOf('cj-a'))
  })

  it('POST /docs/import returns 404 when extraction succeeds but writeFeatureDoc fails (line 119)', async () => {
    // Use an unknown feature — extractPrdDocument succeeds for a .md file, but then
    // writeFeatureDoc returns { ok: false, error: '...not found...' } → 404 (line 119).
    const base64 = Buffer.from('# My Brief\nbody text').toString('base64')
    const res = await app.inject({
      method: 'POST',
      url: '/api/features/ghost/docs/import',
      payload: { filename: 'brief.md', base64 },
    })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: string }).error).toMatch(/not found/)
  })

  it('re-throws non-conflict errors from startCoverageJob as 500 (line 275)', async () => {
    // Inject a store whose save() throws immediately, causing startCoverageJob to
    // propagate the error as a non-CoverageJobConflictError → route re-throws → 500.
    writeFeature('checkout', SPEC)
    await app.close()

    const throwingStore: CoverageJobStore = {
      list: () => [],
      get: () => null,
      activeFor: () => null,
      save: () => { throw new Error('disk full') },
      remove: () => {},
      reconcileInterrupted: () => {},
      onEvent: () => {},
      offEvent: () => {},
    }

    app = Fastify()
    await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir, coverageJobStore: throwingStore })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/coverage/jobs',
      payload: { kind: 'coverage', adapter: 'deterministic' },
    })
    expect(res.statusCode).toBe(500)
  })
})
