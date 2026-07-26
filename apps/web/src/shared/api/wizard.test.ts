import { describe, it, expect, vi } from 'vitest'
import {
  createDraft,
  listDrafts,
  extractPrdDocuments,
  getDraftFile,
  getDraft,
  getDraftAgentLog,
  cancelDraftGeneration,
  acceptPlan,
  acceptSpec,
  rejectDraft,
  deleteDraft,
} from './wizard'
import { ok } from './__fixtures__/response'

describe('wizard api', () => {
  it('getDraftAgentLog fetches the full draft agent log by stage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ content: 'full log' }))
    const out = await getDraftAgentLog('d/1', 'generating', { baseUrl: 'http://x', fetchImpl })
    expect(out).toEqual({ content: 'full log' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/tests/draft/d%2F1/agent-log?stage=generating',
      { method: 'GET' },
    )
  })

  it('createDraft POSTs payload, returns 201 body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd1', status: 'planning' }, 201))
    const out = await createDraft(
      { prdText: 'p', repos: [{ name: 'r', localPath: '/r' }] },
      { fetchImpl },
    )
    expect(out).toEqual({ draftId: 'd1', status: 'planning' })
    const call = (fetchImpl.mock.calls[0] as [string, RequestInit])
    expect(call[0]).toBe('/api/tests/draft')
    expect(call[1].method).toBe('POST')
  })

  it('listDrafts fetches all wizard drafts', async () => {
    const drafts = [{ draftId: 'd1', prdText: 'p', prdDocuments: [], repos: [], status: 'planning', createdAt: 'c', updatedAt: 'u' }]
    const fetchImpl = vi.fn().mockResolvedValue(ok(drafts))
    await expect(listDrafts({ fetchImpl })).resolves.toEqual(drafts)
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft', { method: 'GET' })
  })

  it('extractPrdDocuments builds multipart form data with optional text and files', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ prdText: 'combined', documents: [] }))
    const file = new File(['hello'], 'prd.md', { type: 'text/markdown' })

    await extractPrdDocuments({ prdText: 'notes', files: [file] }, { fetchImpl })

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/tests/prd-documents')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get('prdText')).toBe('notes')
    expect(form.getAll('files')).toEqual([file])
  })

  it('extractPrdDocuments omits empty optional PRD text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ prdText: '', documents: [] }))

    await extractPrdDocuments({ files: [] }, { fetchImpl })

    const form = (fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as FormData
    expect(form.has('prdText')).toBe(false)
    expect(form.getAll('files')).toEqual([])
  })

  it('cancelDraftGeneration POSTs to cancel endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'cancelled' }))
    const out = await cancelDraftGeneration('d', { fetchImpl })
    expect(out.status).toBe('cancelled')
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft/d/cancel-generation', { method: 'POST' })
  })

  it('getDraft URL-encodes the id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'a/b', status: 'created' }))
    await getDraft('a/b', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft/a%2Fb', { method: 'GET' })
  })

  it('getDraftFile encodes path segments but keeps slashes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({ path: 'tests/x.ts', content: 'hi', mime: 'text/plain' }),
    )
    const r = await getDraftFile('d1', 'tests/login spec.ts', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/tests/draft/d1/files/tests/login%20spec.ts',
      { method: 'GET' },
    )
    expect(r.content).toBe('hi')
  })

  it('acceptPlan posts plan when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'generating' }, 202))
    await acceptPlan('d', [{ step: 's', actions: ['a'], expectedOutcome: 'e' }], undefined, { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.plan).toBeDefined()
  })

  it('acceptPlan posts empty body when no plan supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'generating' }, 202))
    await acceptPlan('d', undefined, undefined, { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body).toEqual({})
  })

  it('acceptPlan posts intentSummary when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'generating' }, 202))
    await acceptPlan('d', undefined, 'Edited intent', { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body).toEqual({ intentSummary: 'Edited intent' })
  })

  it('acceptSpec posts featureName when given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'accepted', featureDir: '/x' }))
    await acceptSpec('d', 'my-feat', { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body).toEqual({ featureName: 'my-feat' })
  })

  it('acceptSpec posts empty body when no featureName supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'accepted', featureDir: '/x' }))
    await acceptSpec('d', undefined, { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body).toEqual({})
  })

  it('rejectDraft POSTs and resolves on 204', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(rejectDraft('d', { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft/d/reject', { method: 'POST' })
  })

  it('deleteDraft DELETEs and resolves on 204', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteDraft('d', { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft/d', { method: 'DELETE' })
  })
})
