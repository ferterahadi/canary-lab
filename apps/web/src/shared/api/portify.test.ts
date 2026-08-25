import { describe, it, expect, vi } from 'vitest'
import {
  startPortify,
  getPortify,
  savePortify,
  cancelPortify,
  revisePortify,
  removePortify,
  getPortifyAgentSession,
} from './portify'
import { ok, fail } from './__fixtures__/response'

describe('portify api', () => {
  it('startPortify POSTs the feature/agent/maxAttempts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ workflowId: 'w1' }))
    const r = await startPortify({ feature: 'cns', agent: 'claude', maxAttempts: 2 }, { baseUrl: 'http://x', fetchImpl })
    expect(r).toEqual({ workflowId: 'w1' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/portify')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ feature: 'cns', agent: 'claude', maxAttempts: 2 })
  })

  it('getPortify GETs the workflow manifest', async () => {
    const m = { workflowId: 'w1', status: 'ready-to-save' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(m))
    await expect(getPortify('w1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(m)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/portify/w1', { method: 'GET' })
  })

  it('savePortify and cancelPortify POST to their endpoints', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok({ workflowId: 'w1', status: 'saved' }))
    await savePortify('w1', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenLastCalledWith('http://x/api/portify/w1/save', { method: 'POST' })
    await cancelPortify('w1', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenLastCalledWith('http://x/api/portify/w1/cancel', { method: 'POST' })
  })

  it('revisePortify POSTs the trimmed feedback as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ workflowId: 'w1', status: 'editing' }))
    const r = await revisePortify('w1', 'use PORT', { baseUrl: 'http://x', fetchImpl })
    expect(r).toMatchObject({ workflowId: 'w1', status: 'editing' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/portify/w1/revise')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ feedback: 'use PORT' })
  })

  it('removePortify DELETEs the workflow', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ workflowId: 'w1', removed: true }))
    await expect(removePortify('w1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual({ workflowId: 'w1', removed: true })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/portify/w1', { method: 'DELETE' })
  })

  it('getPortifyAgentSession returns the session on 200 and an absence on 404', async () => {
    const session = { agent: 'claude', sessionId: 's', events: [] }
    const okFetch = vi.fn().mockResolvedValue(ok(session))
    await expect(getPortifyAgentSession('w1', { baseUrl: 'http://x', fetchImpl: okFetch })).resolves.toEqual(session)
    expect(okFetch).toHaveBeenCalledWith('http://x/api/portify/w1/agent-session', { method: 'GET' })
    const notFound = vi.fn().mockResolvedValue(fail(404, { reason: 'no-session' }))
    await expect(getPortifyAgentSession('w1', { baseUrl: 'http://x', fetchImpl: notFound })).resolves.toEqual({ absent: true, reason: 'no-session' })
  })

  it('getPortifyAgentSession rethrows non-404 errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, { error: 'boom' }))
    await expect(getPortifyAgentSession('w1', { baseUrl: 'http://x', fetchImpl })).rejects.toMatchObject({ status: 500 })
  })
})
