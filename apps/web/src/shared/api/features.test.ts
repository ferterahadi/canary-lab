import { describe, it, expect, vi } from 'vitest'
import {
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
