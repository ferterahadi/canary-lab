import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { coverageRoutes } from './coverage'
import { writeRunsIndex } from '../lib/runtime/manifest'
import { buildRunPaths, runDirFor } from '../lib/runtime/run-paths'
import type { CoverageLedger, PrdSummary } from '../../../shared/coverage/types'

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

function writePassingRun(feature: string, runId: string, passedNames: string[]) {
  writeRunsIndex(logsDir, [{ runId, feature, startedAt: '2026-01-01T00:00:00Z', status: 'passed' as never }])
  const runDir = runDirFor(logsDir, runId)
  fs.mkdirSync(runDir, { recursive: true })
  const paths = buildRunPaths(runDir)
  fs.writeFileSync(paths.manifestPath, JSON.stringify({ runId, feature, env: 'local', startedAt: '2026-01-01T00:00:00Z', status: 'passed', services: [] }))
  fs.writeFileSync(paths.summaryPath, JSON.stringify({ complete: true, total: passedNames.length, passed: passedNames.length, passedNames, failed: [] }))
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

  it('regenerate (deterministic) → coverage reflects a grounded passing run', async () => {
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

    // Before any run: requirement is unverified (test exists, no passing run).
    let cov = (await app.inject({ method: 'GET', url: '/api/features/checkout/coverage' })).json() as CoverageLedger
    expect(cov.requirements[0].gapType).toBe('unverified')
    expect(cov.coveragePct).toBe(0)

    // Record a passing run for the test → requirement becomes verified.
    writePassingRun('checkout', 'r1', ['Cart adds an item'])
    cov = (await app.inject({ method: 'GET', url: '/api/features/checkout/coverage' })).json() as CoverageLedger
    expect(cov.requirements[0].gapType).toBe('verified')
    expect(cov.coveragePct).toBe(100)
    expect(cov.requirements[0].lastPassingRun?.runId).toBe('r1')
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
})
