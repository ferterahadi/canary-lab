import { describe, it, expect, vi } from 'vitest'
import {
  getAgentSession,
} from './agent-sessions'
import { ok, fail } from './__fixtures__/response'

describe('agent-sessions api', () => {
  it('getAgentSession returns normalized events and maps 404 to null', async () => {
    const session = {
      agent: 'claude',
      sessionId: 'sid-1',
      events: [{ kind: 'assistant-message', timestamp: 't', text: 'done' }],
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok(session))
      .mockResolvedValueOnce(fail(404, { error: 'agent session not found' }))

    await expect(getAgentSession('run/1', { fetchImpl })).resolves.toEqual(session)
    await expect(getAgentSession('missing', { fetchImpl })).resolves.toBeNull()
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/runs/run%2F1/agent-session')
  })

  it('getAgentSession rethrows non-404 API errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, { error: 'boom' }))
    await expect(getAgentSession('run-1', { fetchImpl })).rejects.toMatchObject({ status: 500 })
  })

  it('getDraftAgentSession encodes the draft id and stage; 404 → null; non-404 throws', async () => {
    const { getDraftAgentSession } = await import('./client')
    const session = { agent: 'claude' as const, sessionId: 'sid', events: [] }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok(session))
      .mockResolvedValueOnce(fail(404, { reason: 'no-session-ref' }))
      .mockResolvedValueOnce(fail(500, { error: 'boom' }))
    await expect(getDraftAgentSession('d/1', 'planning', { fetchImpl })).resolves.toEqual(session)
    await expect(getDraftAgentSession('d/1', 'planning', { fetchImpl })).resolves.toBeNull()
    await expect(getDraftAgentSession('d/1', 'planning', { fetchImpl })).rejects.toMatchObject({ status: 500 })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/tests/draft/d%2F1/agent-session?stage=planning')
  })
})
