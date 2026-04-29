import { describe, it, expect, vi } from 'vitest'
import {
  ApiError,
  listFeatures,
  getFeatureTests,
  listRuns,
  getRunDetail,
  startRun,
  stopRun,
  listJournal,
  deleteJournalEntry,
} from './client'

const ok = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const fail = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('api client', () => {
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

  it('getFeatureTests URL-encodes the feature name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await getFeatureTests('a/b c', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/features/a%2Fb%20c/tests',
      { method: 'GET' },
    )
  })

  it('getFeatureTests throws ApiError on 404 with non-JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('not found', { status: 404 }),
    )
    await expect(getFeatureTests('x', { fetchImpl })).rejects.toMatchObject({
      status: 404,
      body: 'not found',
    })
  })

  it('listRuns sends ?feature= when filter provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await listRuns({ feature: 'feat-a' }, { baseUrl: '', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs?feature=feat-a', { method: 'GET' })
  })

  it('listRuns omits query string when no feature filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await listRuns({}, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs', { method: 'GET' })
  })

  it('getRunDetail fetches the run by id', async () => {
    const detail = { runId: 'r1', manifest: { runId: 'r1', feature: 'f', startedAt: 'x', status: 'running', healCycles: 0, services: [] } }
    const fetchImpl = vi.fn().mockResolvedValue(ok(detail))
    const out = await getRunDetail('r1', { fetchImpl })
    expect(out).toEqual(detail)
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r1', { method: 'GET' })
  })

  it('startRun POSTs JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'r2' }, 201))
    const out = await startRun('feat-x', { fetchImpl })
    expect(out).toEqual({ runId: 'r2' })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'feat-x' }),
    })
  })

  it('startRun throws ApiError on 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(400, { error: 'feature required' }))
    await expect(startRun('', { fetchImpl })).rejects.toBeInstanceOf(ApiError)
  })

  it('stopRun resolves on 204 (empty body)', async () => {
    // Response disallows status 204 with a body — pass `null` body explicitly.
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(stopRun('r3', { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r3', { method: 'DELETE' })
  })

  it('stopRun throws ApiError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'run not found' }))
    await expect(stopRun('missing', { fetchImpl })).rejects.toMatchObject({ status: 404 })
  })

  it('listJournal sends both feature and run query params when set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await listJournal({ feature: 'f', run: 'r' }, { fetchImpl })
    const url = (fetchImpl.mock.calls[0] as [string, RequestInit])[0]
    expect(url).toMatch(/^\/api\/journal\?/)
    expect(url).toContain('feature=f')
    expect(url).toContain('run=r')
  })

  it('listJournal omits query string when no filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await listJournal({}, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/journal', { method: 'GET' })
  })

  it('deleteJournalEntry DELETEs the iteration and resolves on 204', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteJournalEntry(7, { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/journal/7', { method: 'DELETE' })
  })

  it('deleteJournalEntry throws ApiError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'iteration not found' }))
    await expect(deleteJournalEntry(99, { fetchImpl })).rejects.toBeInstanceOf(ApiError)
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
