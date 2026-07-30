import { describe, it, expect, vi } from 'vitest'
import {
  listDrafts,
  getDraft,
  cancelDraftGeneration,
  deleteDraft,
} from './wizard'
import { ok } from './__fixtures__/response'

describe('wizard api', () => {
  it('listDrafts fetches every draft record', async () => {
    const drafts = [{ draftId: 'd1', prdText: 'p', prdDocuments: [], repos: [], status: 'generating', createdAt: 'c', updatedAt: 'u' }]
    const fetchImpl = vi.fn().mockResolvedValue(ok(drafts))
    await expect(listDrafts({ fetchImpl })).resolves.toEqual(drafts)
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft', { method: 'GET' })
  })

  it('getDraft URL-encodes the id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'a/b', status: 'created' }))
    await getDraft('a/b', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft/a%2Fb', { method: 'GET' })
  })

  it('cancelDraftGeneration POSTs to the cancel endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'cancelled' }))
    const out = await cancelDraftGeneration('d', { fetchImpl })
    expect(out.status).toBe('cancelled')
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft/d/cancel-generation', { method: 'POST' })
  })

  it('deleteDraft DELETEs and resolves on 204', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteDraft('d', { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft/d', { method: 'DELETE' })
  })
})
