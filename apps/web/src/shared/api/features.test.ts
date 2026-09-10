import { describe, it, expect, vi } from 'vitest'
import {
  getTestFileReview,
  listFeatures,
  approveDirtySpecs,
  commitDirtySpecs,
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
    const fetchImpl = vi.fn(async () => ok(review))
    await expect(getTestFileReview('feat/a', 'e2e/a.spec.ts', 'run 1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(review)
    await getTestFileReview('feat/a', 'e2e/a.spec.ts', undefined, { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'http://x/api/features/feat%2Fa/test-review?file=e2e%2Fa.spec.ts&runId=run+1',
      'http://x/api/features/feat%2Fa/test-review?file=e2e%2Fa.spec.ts',
    ])
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
