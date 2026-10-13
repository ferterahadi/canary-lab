import { describe, it, expect, vi } from 'vitest'
import { agentSessionAbsence, getAgentSession, isAgentSessionAbsence, requestAgentSession, type AgentSessionResponse } from './agent-sessions'
import { getBenchmarkAgentSession } from './benchmark'
import { getCoverageAgentSession, getEvaluationAgentSession } from './coverage'
import { getFlightAgentSession, getFlightPlanAgentSession } from './flights'
import { getPortifyAgentSession } from './portify'
import { ApiError } from './internal'
import { ok, fail } from './__fixtures__/response'

describe('agent-sessions api', () => {
  it.each([
    [getAgentSession, '/api/runs/id%2F%3F/agent-session'],
    [getBenchmarkAgentSession, '/api/benchmarks/id%2F%3F/agent-session'],
    [getCoverageAgentSession, '/api/coverage/jobs/id%2F%3F/agent-session'],
    [getEvaluationAgentSession, '/api/evaluation-exports/id%2F%3F/agent-session'],
    [getFlightPlanAgentSession, '/api/flights/plan-features/id%2F%3F/agent-session'],
    [getPortifyAgentSession, '/api/portify/id%2F%3F/agent-session'],
  ] as const)('forwards the client and encodes the path for %s', async (getSession, pathname) => {
    const session: AgentSessionResponse = { agent: 'codex', sessionId: 's', events: [] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(session))
    await expect(getSession('id/?', { baseUrl: 'http://canary.test', fetchImpl })).resolves.toEqual(session)
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(`http://canary.test${pathname}`, { method: 'GET' })
  })

  it('encodes the flight stage independently of the flight ID', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ agent: 'claude', sessionId: 's', events: [] }))
    await getFlightAgentSession('id/?', 'stage/&?', { baseUrl: 'http://canary.test', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      'http://canary.test/api/flights/id%2F%3F/agent-session?stage=stage%2F%26%3F', { method: 'GET' },
    )
  })

  it.each([getBenchmarkAgentSession, getCoverageAgentSession])('preserves successful null responses for %s', async (getSession) => {
    await expect(getSession('id', { fetchImpl: vi.fn().mockResolvedValue(ok(null)) })).resolves.toBeNull()
  })

  it('does not cache or coalesce identical session requests', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok(null))
    const opts = { fetchImpl }
    await expect(Promise.all([
      requestAgentSession<AgentSessionResponse | null>('/session', opts),
      requestAgentSession<AgentSessionResponse | null>('/session', opts),
    ])).resolves.toEqual([null, null])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([new TypeError('network unavailable'), new ApiError(503, { error: 'unavailable' })])(
    'propagates the original non-404 error', async (error) => {
      await expect(requestAgentSession('/session', { fetchImpl: vi.fn().mockRejectedValue(error) })).rejects.toBe(error)
    },
  )

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
