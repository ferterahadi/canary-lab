import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMcpRestAdapters } from './rest-adapters'
import { gettingStartedRunWorkflow, isGettingStartedFlightStart, SAMPLE_SUITE, WORKBENCH_SUITE, SAMPLE_FLIGHT_REPO_DIR } from '../features/config/routes/onboarding'
import { MCP_ORIGIN_HEADER } from '../features/flights/routes/flight-decision-origin'

let app: FastifyInstance
let adapters: ReturnType<typeof createMcpRestAdapters>
let status: number
let payload: string
let received: { method: string; url: string; body: unknown; origin: unknown }
const classifyRun = vi.fn(gettingStartedRunWorkflow)
const classifyFlight = vi.fn(isGettingStartedFlightStart)
const inject = vi.fn((request: InjectOptions) => app.inject(request))
function respond(code: number, body: unknown): void {
  status = code
  payload = JSON.stringify(body)
}
beforeEach(() => {
  vi.clearAllMocks()
  app = Fastify()
  respond(200, { runId: 'run-1' })
  app.route({ method: ['GET', 'POST', 'PUT'], url: '/api/*', handler: (request, reply) => {
    received = { method: request.method, url: request.url, body: request.body, origin: request.headers[MCP_ORIGIN_HEADER] }
    return reply.code(status).type('application/json').send(payload)
  } })
  adapters = createMcpRestAdapters({ inject, gettingStartedRunWorkflow: classifyRun, isGettingStartedFlightStart: classifyFlight })
})
afterEach(async () => { await app.close() })

describe('MCP REST adapters', () => {
  it.each(['coverageRequest', 'testReviewRequest', 'discoveryRepairRequest'] as const)('%s retains strict JSON parsing and status codes', async (name) => {
    respond(409, { error: 'blocked' })
    expect(await adapters[name]({ method: 'GET', url: '/api/probe' })).toEqual({ statusCode: 409, body: { error: 'blocked' } })
    expect(received).toEqual({ method: 'GET', url: '/api/probe', body: undefined, origin: name === 'testReviewRequest' ? 'mcp' : undefined })
    payload = 'not json'
    await expect(adapters[name]({ method: 'GET', url: '/api/probe' })).rejects.toBeInstanceOf(SyntaxError)
  })
  it.each(['testReviewRequest', 'discoveryRepairRequest'] as const)('%s forwards POST payloads', async (name) => {
    await adapters[name]({ method: 'POST', url: '/api/probe', payload: { revision: 'rev-1' } })
    expect(received).toMatchObject({ method: 'POST', body: { revision: 'rev-1' } })
  })
  it('marks Flight requests as MCP and attributes only demo creation', async () => {
    const original = { feature: SAMPLE_FLIGHT_REPO_DIR, gettingStartedSource: 'internal' }
    expect(await adapters.flightsRequest({ method: 'POST', url: '/api/flights', payload: original })).toEqual({ statusCode: 200, body: { runId: 'run-1' } })
    expect(received).toMatchObject({ origin: 'mcp', body: { ...original, gettingStartedSource: 'external' } })
    expect(original.gettingStartedSource).toBe('internal')
    await adapters.flightsRequest({ method: 'POST', url: '/api/flights', payload: { feature: 'ordinary' } })
    expect(received.body).toEqual({ feature: 'ordinary' })
    await adapters.flightsRequest({ method: 'POST', url: '/api/flights/f-1/resume', payload: original })
    expect(received.body).toEqual(original)
    await adapters.flightsRequest({ method: 'GET', url: '/api/flights' })
    expect(inject.mock.lastCall?.[0]).not.toHaveProperty('payload')
    expect(received.origin).toBe('mcp')
    payload = 'upstream unavailable'
    status = 503
    expect(await adapters.flightsRequest({ method: 'GET', url: '/api/flights' })).toEqual({ statusCode: 503, body: payload })
  })
  it.each([200, 201])('translates run success %i', async (code) => {
    respond(code, { runId: 123 })
    expect(await adapters.startRun('ordinary')).toEqual({ kind: 'started', runId: '123' })
    expect(received).toEqual({ method: 'POST', url: '/api/runs', body: { feature: 'ordinary' }, origin: undefined })
  })
  it('preserves explicit false, heal metadata, isolation, and demo attribution', async () => {
    const heal = { kind: 'external' as const, sessionId: 'session', clientKind: 'codex' as const, claimable: false }
    await adapters.startRun(SAMPLE_SUITE, 'local', heal, 'queue', 'run', false)
    expect(received.body).toEqual({ feature: SAMPLE_SUITE, env: 'local', healAgent: heal, isolation: 'queue', updateRepos: false,
      gettingStartedSource: 'external', gettingStartedWorkflow: 'run' })
    await adapters.startRun(WORKBENCH_SUITE, undefined, undefined, 'worktree', undefined, true)
    expect(received.body).toEqual({ feature: WORKBENCH_SUITE, isolation: 'worktree', updateRepos: true,
      gettingStartedSource: 'external', gettingStartedWorkflow: 'heal' })
    classifyRun.mockClear()
    await adapters.startRun(SAMPLE_SUITE, undefined, undefined, undefined, 'boot')
    expect(received.body).toEqual({ feature: SAMPLE_SUITE, mode: 'boot' })
    expect(classifyRun).not.toHaveBeenCalled()
  })
  it.each(['repo-collision', 'resources', undefined])('translates queue reason %s', async (reason) => {
    respond(202, { runId: 'queued', queueReason: reason })
    expect(await adapters.startRun('ordinary')).toEqual({ kind: 'queued', runId: 'queued', reason: reason === 'repo-collision' ? reason : 'resources' })
  })
  it('retains collision details and defaults', async () => {
    respond(409, { type: 'repo_collision_requires_choice', conflictingRunId: 'busy', conflictingFeature: 'other', repoPaths: ['/repo'], message: 'choose' })
    expect(await adapters.startRun('ordinary')).toEqual({ kind: 'collision', conflictingRunId: 'busy', conflictingFeature: 'other', repoPaths: ['/repo'], options: ['worktree', 'queue'], message: 'choose' })
    respond(409, { type: 'repo_collision_requires_choice', conflictingRunId: 12, conflictingFeature: 'other', repoPaths: 'bad' })
    expect(await adapters.startRun('ordinary')).toMatchObject({ conflictingRunId: '12', repoPaths: [], message: 'Same-app collision.' })
  })
  it('retains repository-update refusal details and defaults', async () => {
    const repos = [{ name: 'app', reason: 'dirty' }]
    respond(409, { type: 'repo_update_refused', repos, error: 'dirty checkout' })
    expect(await adapters.startRun('ordinary')).toEqual({ kind: 'repo-update-refused', repos, message: 'dirty checkout' })
    respond(409, { type: 'repo_update_refused', repos: 'bad' })
    expect(await adapters.startRun('ordinary')).toEqual({ kind: 'repo-update-refused', repos: [], message: 'Repo upstream update refused.' })
  })
  it('retains the Getting Started owner and default message', async () => {
    const active = { sessionId: 'demo', workflow: 'heal', owner: 'external', target: { kind: 'run', id: 'r' } }
    respond(409, { type: 'getting_started_busy', active, error: 'busy' })
    expect(await adapters.startRun('ordinary')).toEqual({ kind: 'getting-started-busy', active, message: 'busy' })
    respond(409, { type: 'getting_started_busy', active })
    expect(await adapters.startRun('ordinary')).toMatchObject({ message: 'Another Getting Started demo is already running.' })
  })
  it('preserves review error metadata and generic failure messages', async () => {
    const review = { type: 'test_review_required', error: 'review first', revision: 'rev' }
    respond(409, review)
    await expect(adapters.startRun('ordinary')).rejects.toMatchObject({ message: 'review first', testReviewRequired: review })
    respond(400, { error: 'bad feature' })
    await expect(adapters.startRun('ordinary')).rejects.toThrow('start_run failed (400): bad feature')
    respond(500, false)
    await expect(adapters.startRun('ordinary')).rejects.toThrow('start_run failed (500): false')
    respond(500, { message: 'unrecognized' })
    await expect(adapters.startRun('ordinary')).rejects.toThrow(`start_run failed (500): ${payload}`)
  })
  it.each([400, 409, 500])('preserves status %i and raw text for unstructured run errors', async (code) => {
    status = code
    for (const body of ['plain error', 'null', 'false', 'true', '123', '"quoted error"', '[]', '[{"error":"nested"}]', '', '{broken']) {
      payload = body
      await expect(adapters.startRun('ordinary')).rejects.toMatchObject({
        name: 'Error', message: `start_run failed (${code}): ${body}`,
      })
    }
  })
  it.each([200, 201])('forwards verification input and parses success %i strictly', async (code) => {
    respond(code, { runId: 'verify' })
    const input = { playwrightEnvsetId: 'prod', bootRunId: 'boot' }
    expect(await adapters.startVerification('suite /#', input)).toEqual({ runId: 'verify' })
    expect(received).toMatchObject({ method: 'POST', url: '/api/features/suite%20%2F%23/verifications', body: input })
    payload = 'not json'
    await expect(adapters.startVerification('ordinary', input)).rejects.toBeInstanceOf(SyntaxError)
  })
  it.each([200, 201])('forwards envset writes and returns success %i', async (code) => {
    const entries = [{ key: 'URL', value: 'http://localhost' }]
    const body = { path: '/slot', entries, unparsedLines: [3] }
    respond(code, body)
    expect(await adapters.writeEnvsetSlot('suite /', 'env #', 'app/file', entries)).toEqual(body)
    expect(received).toMatchObject({ method: 'PUT', url: '/api/features/suite%20%2F/envsets/env%20%23/app%2Ffile', body: { entries } })
    payload = 'raw success'
    expect(await adapters.writeEnvsetSlot('suite', 'env', 'app', [])).toBe('raw success')
  })
  it.each([
    { body: '{"error":"blocked"}', message: 'blocked' },
    { body: '{"message":"other"}', message: '[object Object]' },
    { body: 'plain failure', message: 'plain failure' },
    { body: 'null', message: 'null' },
  ])('preserves verification/envset failure messages for $body', async ({ body, message }) => {
    status = 403
    payload = body
    await expect(adapters.startVerification('suite', { playwrightEnvsetId: 'prod' })).rejects.toThrow(`execute_verification failed (403): ${message}`)
    await expect(adapters.writeEnvsetSlot('suite', 'env', 'app', [])).rejects.toThrow(`write_envset failed (403): ${message}`)
  })
  it('forwards heal handoffs with optional fields and preserves non-success bodies', async () => {
    respond(409, { error: 'not held' })
    expect(await adapters.handoffHeal('run /#', 'manual', 'session', 'guidance')).toEqual({ statusCode: 409, body: { error: 'not held' } })
    expect(received).toMatchObject({ method: 'POST', url: '/api/runs/run%20%2F%23/heal-agent/handoff', body: { to: 'manual', sessionId: 'session', guidance: 'guidance' } })
    payload = 'raw failure'
    expect(await adapters.handoffHeal('r', 'auto', undefined, undefined)).toEqual({ statusCode: 409, body: 'raw failure' })
    expect(received.body).toEqual({ to: 'auto' })
  })
  it('propagates request failures without rewriting them', async () => {
    const error = new Error('transport unavailable')
    inject.mockRejectedValueOnce(error)
    await expect(adapters.coverageRequest({ method: 'GET', url: '/api/probe' })).rejects.toBe(error)
  })
})
