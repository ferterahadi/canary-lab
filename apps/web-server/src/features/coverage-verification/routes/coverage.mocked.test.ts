// Tests that require vi.mock to drive various route branches that are otherwise
// unreachable without injecting specific error shapes. Kept in a separate file
// because vi.mock is file-scoped and module-hoisted.
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../logic/prd-document-extractor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../logic/prd-document-extractor')>()
  return {
    ...original,
    extractPrdDocument: vi.fn(original.extractPrdDocument),
  }
})

vi.mock('../logic/coverage/service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../logic/coverage/service')>()
  return {
    ...original,
    computeFeatureCoverage: vi.fn(original.computeFeatureCoverage),
    listFeatureDocs: vi.fn(original.listFeatureDocs),
    clearPrdSummary: vi.fn(original.clearPrdSummary),
    regeneratePrdSummary: vi.fn(original.regeneratePrdSummary),
  }
})

vi.mock('../../orchestration/logic/feature-authoring', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../orchestration/logic/feature-authoring')>()
  return {
    ...original,
    writeFeatureDoc: vi.fn(original.writeFeatureDoc),
  }
})

import Fastify, { type FastifyInstance } from 'fastify'
import { coverageRoutes } from './coverage'
import { computeFeatureCoverage, listFeatureDocs, clearPrdSummary, regeneratePrdSummary } from '../logic/coverage/service'
import { writeFeatureDoc } from '../../orchestration/logic/feature-authoring'
import { extractPrdDocument } from '../logic/prd-document-extractor'

let tmpDir: string
let featuresDir: string
let logsDir: string
let app: FastifyInstance

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cov-mocked-route-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  vi.mocked(computeFeatureCoverage).mockReset()
  vi.mocked(listFeatureDocs).mockReset()
  vi.mocked(clearPrdSummary).mockReset()
  vi.mocked(regeneratePrdSummary).mockReset()
  vi.mocked(writeFeatureDoc).mockReset()
  app = Fastify()
  await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmpDir })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('coverage route re-throw branches', () => {
  it('GET /coverage re-throws non-FeatureNotFoundError errors (line 52)', async () => {
    // computeFeatureCoverage throws a generic Error (not FeatureNotFoundError) →
    // route must re-throw → Fastify returns 500.
    vi.mocked(computeFeatureCoverage).mockImplementation(() => {
      throw new Error('corrupted ledger')
    })

    const res = await app.inject({ method: 'GET', url: '/api/features/checkout/coverage' })
    expect(res.statusCode).toBe(500)
  })

  it('GET /docs re-throws non-FeatureNotFoundError errors (line 64)', async () => {
    // listFeatureDocs throws a generic Error (not FeatureNotFoundError) →
    // route must re-throw → Fastify returns 500.
    vi.mocked(listFeatureDocs).mockImplementation(() => {
      throw new Error('read error')
    })

    const res = await app.inject({ method: 'GET', url: '/api/features/checkout/docs' })
    expect(res.statusCode).toBe(500)
  })

  it('DELETE /prd-summary re-throws non-FeatureNotFoundError errors (line 150)', async () => {
    // clearPrdSummary throws a generic Error (not FeatureNotFoundError) → route
    // must re-throw → Fastify returns 500.
    vi.mocked(clearPrdSummary).mockImplementation(() => {
      throw new Error('disk full')
    })

    const res = await app.inject({ method: 'DELETE', url: '/api/features/checkout/prd-summary' })
    expect(res.statusCode).toBe(500)
  })

  it('POST /prd-summary/regenerate re-throws non-FeatureNotFoundError errors (line 169)', async () => {
    // regeneratePrdSummary throws a generic Error (not FeatureNotFoundError) → route
    // must re-throw → Fastify returns 500.
    vi.mocked(regeneratePrdSummary).mockRejectedValue(new Error('agent timeout'))

    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/prd-summary/regenerate',
      payload: { adapter: 'deterministic' },
    })
    expect(res.statusCode).toBe(500)
  })

  it('POST /docs/import returns 400 when writeFeatureDoc fails with a non-not-found error (line 118)', async () => {
    // extractPrdDocument succeeds (markdown file), but writeFeatureDoc returns a
    // non-"not found" error (e.g. content validation failure) → exercises the
    // false branch of `result.error.includes("not found") ? 404 : 400` at line 118.
    vi.mocked(writeFeatureDoc).mockReturnValue({ ok: false, error: 'content must be a non-empty string' })

    const base64 = Buffer.from('# Brief\nbody').toString('base64')
    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/docs/import',
      payload: { filename: 'brief.md', base64 },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toBe('content must be a non-empty string')
  })

  it('POST /docs/import returns 400 with String(err) when extractPrdDocument throws a non-Error (line 109 FALSE branch)', async () => {
    // extractPrdDocument throws a plain string (not an Error instance) →
    // `err instanceof Error` is FALSE → `String(err)` branch at line 109.
    vi.mocked(extractPrdDocument).mockImplementationOnce(() => Promise.reject('upload failed: bad mime type'))

    const base64 = Buffer.from('dummy').toString('base64')
    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/docs/import',
      payload: { filename: 'brief.md', base64 },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toBe('upload failed: bad mime type')
  })
})

describe('coverage/states — ?? null fallback branch (lines 196-198)', () => {
  it('GET /api/coverage/states returns null fields when ledger has no state property', async () => {
    // computeFeatureCoverage returns a ledger without the optional `state` field
    // (state is undefined) → `ledger.state?.headline ?? null` takes the ?? fallback (→ null).
    // This covers the TRUE (nullish) branch of all three ?? operators on lines 196-198.
    const featureDir = path.join(featuresDir, 'checkout')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(
      path.join(featureDir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'checkout', description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
    )

    vi.mocked(computeFeatureCoverage).mockImplementation(() => ({
      feature: 'checkout',
      requirements: [],
      tests: [],
      totals: { total: 0, verified: 0, partial: 0, failing: 0, untested: 0 },
      coveragePct: 0,
      orphanRequirementIds: [],
      orphanTestNames: [],
      // state intentionally omitted — headline/summary/coverage will all be undefined
    }))

    const res = await app.inject({ method: 'GET', url: '/api/coverage/states' })
    expect(res.statusCode).toBe(200)
    const states = res.json() as Array<{ feature: string; headline: string | null; summary: string | null; coverage: string | null }>
    const entry = states.find((s) => s.feature === 'checkout')
    expect(entry).toBeTruthy()
    expect(entry?.headline).toBeNull()
    expect(entry?.summary).toBeNull()
    expect(entry?.coverage).toBeNull()
  })
})
