// Tests that require vi.mock to drive clearPrdSummary / regeneratePrdSummary into
// their non-FeatureNotFoundError re-throw branches (lines 150 and 169 of coverage.ts).
// Kept in a separate file because vi.mock is file-scoped and module-hoisted.
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../lib/coverage/service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/coverage/service')>()
  return {
    ...original,
    computeFeatureCoverage: vi.fn(original.computeFeatureCoverage),
    listFeatureDocs: vi.fn(original.listFeatureDocs),
    clearPrdSummary: vi.fn(original.clearPrdSummary),
    regeneratePrdSummary: vi.fn(original.regeneratePrdSummary),
  }
})

import Fastify, { type FastifyInstance } from 'fastify'
import { coverageRoutes } from './coverage'
import { computeFeatureCoverage, listFeatureDocs, clearPrdSummary, regeneratePrdSummary } from '../lib/coverage/service'

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
})
