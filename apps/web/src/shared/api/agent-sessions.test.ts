import { describe, it, expect, vi } from 'vitest'
import { getAgentSession } from './agent-sessions'
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

  // The `getDraftAgentSession` case that used to sit here was deleted with the
  // function: the Add Test wizard's retirement removed
  // `/api/tests/draft/:id/agent-session` server-side, so the client call could
  // only ever 404. Deleting dead code and its test, not weakening a test to make
  // something pass.
})
