import { describe, it, expect, vi } from 'vitest'
import {
  getFeatureCoverage,
  listFeatureDocs,
  writeFeatureDoc,
  importFeatureDoc,
  deleteFeatureDoc,
  listCoverageStates,
  regeneratePrdSummary,
  startCoverageJob,
  listCoverageJobs,
  listAllCoverageJobs,
  getCoverageJob,
  getCoverageAgentSession,
  getEvaluationAgentSession,
  clearPrdSummary,
} from './coverage'
import { ok, fail } from './__fixtures__/response'

describe('coverage api', () => {
  it('getFeatureCoverage calls the correct URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ coveragePct: 80 }))
    const result = await getFeatureCoverage('checkout', { baseUrl: 'http://x', fetchImpl })
    expect(result).toMatchObject({ coveragePct: 80 })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features/checkout/coverage', { method: 'GET' })
  })

  it('getFeatureCoverage URL-encodes the feature name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({}))
    await getFeatureCoverage('a/b c', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features/a%2Fb%20c/coverage', { method: 'GET' })
  })

  it('listFeatureDocs GETs the docs listing', async () => {
    const listing = { docs: [] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(listing))
    const result = await listFeatureDocs('checkout', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(listing)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features/checkout/docs', { method: 'GET' })
  })

  it('writeFeatureDoc POSTs relPath and content as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ written: true, relativePath: 'prd.md' }))
    const result = await writeFeatureDoc('checkout', 'prd.md', '# PRD', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ written: true, relativePath: 'prd.md' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/features/checkout/docs')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ relPath: 'prd.md', content: '# PRD' })
  })

  it('importFeatureDoc POSTs the file descriptor as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ written: true, relativePath: 'spec.md' }))
    const file = { filename: 'spec.pdf', contentType: 'application/pdf', base64: 'abc=' }
    const result = await importFeatureDoc('checkout', file, { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ written: true, relativePath: 'spec.md' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/features/checkout/docs/import')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(file)
  })

  it('deleteFeatureDoc DELETEs the encoded relPath', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ deleted: true }))
    const result = await deleteFeatureDoc('checkout', 'sub/prd.md', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ deleted: true })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/features/checkout/docs/sub%2Fprd.md',
      { method: 'DELETE' },
    )
  })

  it('listCoverageStates GETs /api/coverage/states', async () => {
    const states = [{ feature: 'checkout', headline: null, summary: null, coverage: null, coveragePct: null }]
    const fetchImpl = vi.fn().mockResolvedValue(ok(states))
    const result = await listCoverageStates({ baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(states)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/coverage/states', { method: 'GET' })
  })

  it('coalesces simultaneous coverage-state reads from the same page load', async () => {
    const states = [{ feature: 'checkout', headline: 'Covered 100%', summary: 'fresh', coverage: 'fresh', coveragePct: 100 }]
    let settle: ((response: Response) => void) | undefined
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { settle = resolve }))

    const first = listCoverageStates({ baseUrl: 'http://x', fetchImpl })
    const second = listCoverageStates({ baseUrl: 'http://x', fetchImpl })

    expect(second).toBe(first)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    settle?.(ok(states))
    await expect(Promise.all([first, second])).resolves.toEqual([states, states])

    fetchImpl.mockResolvedValueOnce(ok(states))
    await expect(listCoverageStates({ baseUrl: 'http://x', fetchImpl })).resolves.toEqual(states)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not clear a newer coverage-state request when an older request settles', async () => {
    const states = [{ feature: 'checkout', headline: 'Covered 100%', summary: 'fresh', coverage: 'fresh', coveragePct: 100 }]
    let settleFirst: ((response: Response) => void) | undefined
    let settleSecond: ((response: Response) => void) | undefined
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { settleFirst = resolve }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { settleSecond = resolve }))

    const older = listCoverageStates({ baseUrl: 'http://one', fetchImpl })
    const newer = listCoverageStates({ baseUrl: 'http://two', fetchImpl })
    settleFirst?.(ok(states))
    await older

    // The old request's finally runs after `coverageStatesInFlight` moved to the
    // second request. It must not erase that newer in-flight record.
    expect(listCoverageStates({ baseUrl: 'http://two', fetchImpl })).toBe(newer)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    settleSecond?.(ok(states))
    await expect(newer).resolves.toEqual(states)
  })

  it('regeneratePrdSummary POSTs with adapter when provided', async () => {
    const payload = { feature: 'checkout', summary: {}, written: [] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(payload))
    const result = await regeneratePrdSummary('checkout', 'claude', { baseUrl: 'http://x', fetchImpl })
    expect(result).toMatchObject({ feature: 'checkout' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/features/checkout/prd-summary/regenerate')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ adapter: 'claude' })
  })

  it('regeneratePrdSummary POSTs empty body when adapter is omitted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ feature: 'checkout', summary: {}, written: [] }))
    await regeneratePrdSummary('checkout', undefined, { baseUrl: 'http://x', fetchImpl })
    expect(JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({})
  })

  it('startCoverageJob POSTs kind (and optional adapter)', async () => {
    const manifest = { jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'running' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest, 202))
    const result = await startCoverageJob('checkout', 'summary', { baseUrl: 'http://x', fetchImpl, adapter: 'claude' })
    expect(result).toMatchObject({ jobId: 'j1' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/features/checkout/coverage/jobs')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'summary', adapter: 'claude' })
  })

  it('startCoverageJob omits adapter when not provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ jobId: 'j2' }, 202))
    await startCoverageJob('checkout', 'coverage', { baseUrl: 'http://x', fetchImpl })
    expect(JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ kind: 'coverage' })
  })

  it('startCoverageJob rides the launch-gate model plan (with its adapter pin) in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ jobId: 'j9' }))
    const models = { prd: { model: 'opus', effort: 'max' }, mapping: { model: null, effort: 'low' } }
    await startCoverageJob('checkout', 'summary', { baseUrl: 'http://x', fetchImpl, adapter: 'claude', models })
    const [, init] = fetchImpl.mock.calls[0]
    expect(JSON.parse((init as { body: string }).body)).toEqual({ kind: 'summary', adapter: 'claude', models })
  })

  it('startCoverageJob carries the Getting Started source so the demo claim rides the same POST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ jobId: 'j3' }, 202))
    await startCoverageJob('checkout', 'summary', { baseUrl: 'http://x', fetchImpl, gettingStartedSource: 'internal' })
    expect(JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string))
      .toEqual({ kind: 'summary', gettingStartedSource: 'internal' })
  })

  it('listCoverageJobs GETs the feature-scoped jobs list', async () => {
    const jobs = [{ jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done' }]
    const fetchImpl = vi.fn().mockResolvedValue(ok(jobs))
    const result = await listCoverageJobs('checkout', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(jobs)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features/checkout/coverage/jobs', { method: 'GET' })
  })

  it('listAllCoverageJobs GETs the global jobs list', async () => {
    const jobs = [{ jobId: 'j1' }, { jobId: 'j2' }]
    const fetchImpl = vi.fn().mockResolvedValue(ok(jobs))
    const result = await listAllCoverageJobs({ baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(jobs)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/coverage/jobs', { method: 'GET' })
  })

  it('getCoverageJob GETs and encodes the jobId', async () => {
    const manifest = { jobId: 'j/1', feature: 'checkout', kind: 'summary', status: 'done' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest))
    const result = await getCoverageJob('j/1', { baseUrl: 'http://x', fetchImpl })
    expect(result).toMatchObject({ jobId: 'j/1' })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/coverage/jobs/j%2F1', { method: 'GET' })
  })

  it('getCoverageAgentSession returns the session on 200', async () => {
    const session = { agent: 'claude' as const, sessionId: 's1', events: [] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(session))
    const result = await getCoverageAgentSession('job1', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(session)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/coverage/jobs/job1/agent-session', { method: 'GET' })
  })

  it('getCoverageAgentSession maps 404 to an absence (reason-less body → null reason)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'not found' }))
    const result = await getCoverageAgentSession('job1', { fetchImpl })
    expect(result).toEqual({ absent: true, reason: null })
  })

  it('getCoverageAgentSession rethrows non-404 errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, {}))
    await expect(getCoverageAgentSession('job1', { fetchImpl })).rejects.toMatchObject({ status: 500 })
  })

  it('getCoverageAgentSession URL-encodes the jobId', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ agent: 'claude', sessionId: 's', events: [] }))
    await getCoverageAgentSession('j/1', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/coverage/jobs/j%2F1/agent-session', { method: 'GET' })
  })

  it('getEvaluationAgentSession returns the session on 200', async () => {
    const session = { agent: 'claude' as const, sessionId: 'es1', events: [] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(session))
    const result = await getEvaluationAgentSession('task/1', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(session)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/evaluation-exports/task%2F1/agent-session', { method: 'GET' })
  })

  it('getEvaluationAgentSession maps 404 to an absence carrying the reason', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'not found', reason: 'no-session-ref' }))
    const result = await getEvaluationAgentSession('task1', { fetchImpl })
    expect(result).toEqual({ absent: true, reason: 'no-session-ref' })
  })

  it('getEvaluationAgentSession rethrows non-404 errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, {}))
    await expect(getEvaluationAgentSession('task1', { fetchImpl })).rejects.toMatchObject({ status: 500 })
  })

  it('clearPrdSummary DELETEs the prd-summary endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ feature: 'checkout', removed: ['prd-summary.json'] }))
    const result = await clearPrdSummary('checkout', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ feature: 'checkout', removed: ['prd-summary.json'] })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features/checkout/prd-summary', { method: 'DELETE' })
  })

  it('clearPrdSummary URL-encodes the feature name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ feature: 'a/b', removed: [] }))
    await clearPrdSummary('a/b', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features/a%2Fb/prd-summary', { method: 'DELETE' })
  })
})
