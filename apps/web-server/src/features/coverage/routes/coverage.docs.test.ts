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
  it('lists docs and reports drift after a source doc changes', async () => {
    const dir = writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nbody' })
    await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: {} })

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
    // Adding a doc must announce itself so the open Docs rail / coverage badge
    // refresh live (cl_ws-driven-state).
    expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
  })

  it('rejects a doc write with missing fields', async () => {
    writeFeature('checkout', SPEC)
    const res = await app.inject({ method: 'POST', url: '/api/features/checkout/docs', payload: { relPath: 'x.md' } })
    expect(res.statusCode).toBe(400)
  })

  it('imports an uploaded doc (extracted to markdown) then lists it', async () => {
    writeFeature('checkout', SPEC)
    const base64 = Buffer.from('# Imported brief\nbody text').toString('base64')
    const imp = await app.inject({ method: 'POST', url: '/api/features/checkout/docs/import', payload: { filename: 'brief.md', base64 } })
    expect(imp.statusCode).toBe(200)
    expect((imp.json() as { relativePath: string }).relativePath).toContain('brief.md')
    const docs = (await app.inject({ method: 'GET', url: '/api/features/checkout/docs' })).json() as { docs: { relPath: string }[] }
    expect(docs.docs.map((d) => d.relPath)).toContain('brief.md')
    expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })
  })

  it('deletes a source doc but refuses a generated artifact', async () => {
    const dir = writeFeature('checkout', SPEC, { 'spec.md': '# Cart adds an item\nbody' })
    await app.inject({ method: 'POST', url: '/api/features/checkout/prd-summary/regenerate', payload: {} })

    const ok = await app.inject({ method: 'DELETE', url: '/api/features/checkout/docs/spec.md' })
    expect(ok.statusCode).toBe(200)
    expect(fs.existsSync(path.join(dir, 'docs', 'spec.md'))).toBe(false)
    expect(events).toContainEqual({ type: 'coverage-changed', feature: 'checkout' })

    const refused = await app.inject({ method: 'DELETE', url: '/api/features/checkout/docs/_prd-summary.md' })
    expect(refused.statusCode).toBe(400)
  })

  it('GET /api/features/:name/docs returns 404 for an unknown feature', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/features/ghost/docs' })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { error: string }).error).toMatch(/ghost/)
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
})

describe('POST /api/features/:name/docs/link + symlink-aware listing', () => {
  it('links a local path into docs/ and the listing marks it linked', async () => {
    writeFeature('checkout', SPEC)
    const target = path.join(tmpDir, 'external-prd.md')
    fs.writeFileSync(target, '# External')
    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/docs/link',
      payload: { path: target },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ written: true, linked: true })
    expect(events.some((e) => e.type === 'coverage-changed')).toBe(true)

    const list = await app.inject({ method: 'GET', url: '/api/features/checkout/docs' })
    const docs = (list.json() as { docs: Array<Record<string, unknown>> }).docs
    const linkedDoc = docs.find((d) => d.relPath === 'external-prd.md')!
    expect(linkedDoc).toMatchObject({ linked: true, linkTarget: expect.stringContaining('external-prd.md') })
    expect(linkedDoc.broken).toBeUndefined()
  })

  it('a dangling link is listed as broken instead of crashing the rail', async () => {
    writeFeature('checkout', SPEC)
    const target = path.join(tmpDir, 'gone.md')
    fs.writeFileSync(target, 'soon gone')
    await app.inject({ method: 'POST', url: '/api/features/checkout/docs/link', payload: { path: target } })
    fs.rmSync(target)
    const list = await app.inject({ method: 'GET', url: '/api/features/checkout/docs' })
    expect(list.statusCode).toBe(200)
    const docs = (list.json() as { docs: Array<Record<string, unknown>> }).docs
    expect(docs.find((d) => d.relPath === 'gone.md')).toMatchObject({ linked: true, broken: true })
  })

  it('links a local path using an explicit relPath override (line 154 true branch)', async () => {
    writeFeature('checkout', SPEC)
    const target = path.join(tmpDir, 'external-prd.md')
    fs.writeFileSync(target, '# External')
    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/docs/link',
      payload: { path: target, relPath: 'renamed-prd.md' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { relativePath: string }).relativePath).toContain('renamed-prd.md')

    const list = await app.inject({ method: 'GET', url: '/api/features/checkout/docs' })
    const docs = (list.json() as { docs: Array<Record<string, unknown>> }).docs
    // The default basename ('external-prd.md') must NOT be used — the explicit
    // relPath took over the doc's name inside docs/.
    expect(docs.find((d) => d.relPath === 'renamed-prd.md')).toBeTruthy()
    expect(docs.find((d) => d.relPath === 'external-prd.md')).toBeUndefined()
  })

  it('validates the body and maps lib failures to 400/404', async () => {
    writeFeature('checkout', SPEC)
    const noPath = await app.inject({ method: 'POST', url: '/api/features/checkout/docs/link', payload: {} })
    expect(noPath.statusCode).toBe(400)
    const missing = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/docs/link',
      payload: { path: path.join(tmpDir, 'nope.md') },
    })
    expect(missing.statusCode).toBe(400)
    const ghost = await app.inject({
      method: 'POST',
      url: '/api/features/ghost/docs/link',
      payload: { path: path.join(tmpDir, 'nope.md') },
    })
    expect([400, 404]).toContain(ghost.statusCode)
  })
})
