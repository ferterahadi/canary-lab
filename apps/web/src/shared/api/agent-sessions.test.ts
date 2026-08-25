import { describe, it, expect, vi } from 'vitest'
import { agentSessionAbsence, getAgentSession, isAgentSessionAbsence, type AgentSessionResponse } from './agent-sessions'
import { ApiError } from './internal'
import { ok, fail } from './__fixtures__/response'

describe('agent-sessions api', () => {
  it('getAgentSession returns normalized events and maps 404 to an absence', async () => {
    const session = {
      agent: 'claude',
      sessionId: 'sid-1',
      events: [{ kind: 'assistant-message', timestamp: 't', text: 'done' }],
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok(session))
      .mockResolvedValueOnce(fail(404, { error: 'run not found', reason: 'run-not-found' }))
      .mockResolvedValueOnce(fail(404, { error: 'agent session not found' }))

    await expect(getAgentSession('run/1', { fetchImpl })).resolves.toEqual(session)
    // The server's reason survives the mapping; a body without one → null reason.
    await expect(getAgentSession('missing', { fetchImpl })).resolves.toEqual({ absent: true, reason: 'run-not-found' })
    await expect(getAgentSession('missing', { fetchImpl })).resolves.toEqual({ absent: true, reason: null })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/runs/run%2F1/agent-session')
  })

  it('getAgentSession rethrows non-404 API errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, { error: 'boom' }))
    await expect(getAgentSession('run-1', { fetchImpl })).rejects.toMatchObject({ status: 500 })
  })

  it('agentSessionAbsence takes the reason only from an object body with a string reason', () => {
    expect(agentSessionAbsence(new ApiError(404, { reason: 'no-session' }))).toEqual({ absent: true, reason: 'no-session' })
    // Non-string reason, non-object body, and no body at all (a 404 with an
    // empty response text parses to null) each yield a reason-less absence.
    expect(agentSessionAbsence(new ApiError(404, { reason: 42 }))).toEqual({ absent: true, reason: null })
    expect(agentSessionAbsence(new ApiError(404, 'not json'))).toEqual({ absent: true, reason: null })
    expect(agentSessionAbsence(new ApiError(404, null))).toEqual({ absent: true, reason: null })
  })

  it('isAgentSessionAbsence discriminates the fetch-result union', () => {
    const session: AgentSessionResponse = { agent: 'claude', sessionId: 's', events: [] }
    expect(isAgentSessionAbsence({ absent: true, reason: null })).toBe(true)
    expect(isAgentSessionAbsence(session)).toBe(false)
    expect(isAgentSessionAbsence(null)).toBe(false)
  })

  // The `getDraftAgentSession` case that used to sit here was deleted with the
  // function: the Add Test wizard's retirement removed
  // `/api/tests/draft/:id/agent-session` server-side, so the client call could
  // only ever 404. Deleting dead code and its test, not weakening a test to make
  // something pass.
})
