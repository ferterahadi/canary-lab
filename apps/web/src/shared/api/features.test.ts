import { describe, it, expect, vi } from 'vitest'
import {
  getTestFileReview,
  getTestFileDifference,
  getTestSourceComparison,
  listFeatures,
  approveDirtySpecs,
  commitDirtySpecs,
  getFeatureTestReview,
  acceptFeatureTestReview,
  restoreFeatureTestReview,
  getFeatureDirtyDiff,
} from './features'
import { ok, fail } from './__fixtures__/response'

describe('features api', () => {
  it('listFeatures returns parsed array on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([{ name: 'feat-a', repos: [], envs: [] }]))
    const result = await listFeatures({ baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual([{ name: 'feat-a', repos: [], envs: [] }])
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features', { method: 'GET' })
  })

  it('listFeatures throws ApiError on 500 with body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, { error: 'boom' }))
    await expect(listFeatures({ fetchImpl })).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      body: { error: 'boom' },
    })
  })

  it('approveDirtySpecs POSTs to the approve-dirty endpoint and returns status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ status: 'clean' }))
    const result = await approveDirtySpecs('feat/a', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ status: 'clean' })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features/feat%2Fa/approve-dirty', { method: 'POST' })
  })

  it('commitDirtySpecs POSTs to the commit-dirty endpoint and returns the commit result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ committed: true, status: 'clean' }))
    const result = await commitDirtySpecs('feat/a', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ committed: true, status: 'clean' })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features/feat%2Fa/commit-dirty', { method: 'POST' })
  })

  it('commitDirtySpecs surfaces a not-committed reason in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ committed: false, reason: 'nothing to commit' }))
    const result = await commitDirtySpecs('feat/a', { fetchImpl })
    expect(result).toEqual({ committed: false, reason: 'nothing to commit' })
  })

  it('commitDirtySpecs throws ApiError on failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, { error: 'git commit failed' }))
    await expect(commitDirtySpecs('feat/a', { fetchImpl })).rejects.toMatchObject({ status: 500 })
  })

  it('reads and settles a suite review with the exact revision', async () => {
    const review = { feature: 'feat/a', baseline: 'head', review_revision: 'a'.repeat(64), files: [{ file: 'e2e/a.spec.ts', change: 'modified' }] }
    const receipt = { decision: 'accepted', review_revision: review.review_revision, files: ['e2e/a.spec.ts'], at: 'now', git: { status: 'committed', commit: 'abc' }, execution: { status: 'none' } }
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok(review))
      .mockResolvedValueOnce(ok(receipt))
      .mockResolvedValueOnce(ok({ ...receipt, decision: 'restored', git: { status: 'not-requested' } }))
    await expect(getFeatureTestReview('feat/a', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(review)
    await acceptFeatureTestReview('feat/a', review.review_revision, { baseUrl: 'http://x', fetchImpl })
    await restoreFeatureTestReview('feat/a', review.review_revision, { baseUrl: 'http://x', fetchImpl })
    const decision = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: review.review_revision }) }
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://x/api/features/feat%2Fa/test-review-plan', { method: 'GET' })
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://x/api/features/feat%2Fa/accept-test-review', decision)
    expect(fetchImpl).toHaveBeenNthCalledWith(3, 'http://x/api/features/feat%2Fa/restore-test-review', decision)
  })

  it('getFeatureDirtyDiff GETs the dirty-diff endpoint with encoded feature and file', async () => {
    const diff = { tests: [{ name: 'logs in', changedLines: [10, 11, 12] }] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(diff))
    const result = await getFeatureDirtyDiff('feat/a', 'tests/login spec.ts', { baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(diff)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/features/feat%2Fa/dirty-diff?file=tests%2Flogin%20spec.ts',
      { method: 'GET' },
    )
  })

  it('getFeatureDirtyDiff throws ApiError on 404 when the spec is not dirty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'not dirty' }))
    await expect(getFeatureDirtyDiff('feat/a', 'tests/x.ts', { fetchImpl })).rejects.toMatchObject({ status: 404 })
  })

  it('getTestFileReview pins the review to one run when the caller names it, and to HEAD when it does not', async () => {
    // `runId` selects the run-start snapshot as the committed side. Dropping it
    // from the query would silently review against HEAD instead — a different
    // baseline, and the wrong evidence for a mid-run spec edit.
    const review = { before: { source: '', tests: [] }, after: { source: '', tests: [] }, patch: '', baseline: 'run-start', assessment: { tests: [] } }
    // A fresh Response per call: a body can only be read once.
    const fetchImpl = vi.fn<typeof fetch>(async () => ok(review))
    await expect(getTestFileReview('feat/a', 'e2e/a.spec.ts', 'run 1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(review)
    await getTestFileReview('feat/a', 'e2e/a.spec.ts', undefined, { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'http://x/api/features/feat%2Fa/test-review?file=e2e%2Fa.spec.ts&runId=run+1',
      'http://x/api/features/feat%2Fa/test-review?file=e2e%2Fa.spec.ts',
    ])
  })

  it('getTestFileDifference always names a run and asks for the summary only', async () => {
    // The run is the baseline the Tests column marks against, and `summary`
    // keeps both file versions off the wire — the reply is a verdict, not a diff.
    const summary = { changed: true, affectedTests: ['pays'], verdict: 'weaker' as const }
    const fetchImpl = vi.fn(async () => ok(summary))
    await expect(getTestFileDifference('feat/a', 'e2e/a.spec.ts', 'run 1', { baseUrl: 'http://x', fetchImpl }))
      .resolves.toEqual(summary)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/features/feat%2Fa/test-review?file=e2e%2Fa.spec.ts&runId=run+1&summary=true',
      { method: 'GET' },
    )
  })

  it('gets source declaration changes for exactly the selected suite and run', async () => {
    const comparison = { state: 'ready', files: [], differences: [], changes: { added: [], changed: [], removed: [] } }
    const fetchImpl = vi.fn().mockResolvedValue(ok(comparison))
    await expect(getTestSourceComparison('feat/a', 'run 1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(comparison)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features/feat%2Fa/test-source-comparison?runId=run+1', { method: 'GET' })
  })

  it('uses globalThis.fetch by default when no fetchImpl provided', async () => {
    const original = globalThis.fetch
    const stub = vi.fn().mockResolvedValue(ok([]))
    ;(globalThis as { fetch: typeof fetch }).fetch = stub as unknown as typeof fetch
    try {
      await listFeatures()
      expect(stub).toHaveBeenCalled()
    } finally {
      ;(globalThis as { fetch: typeof fetch }).fetch = original
    }
  })
})
