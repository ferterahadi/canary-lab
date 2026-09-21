import { describe, expect, it, vi } from 'vitest'
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { captureTools } from './__fixtures__/tool-group-harness'
import { registerTestReviewTools } from './test-review'

const facts = { surface: 'codex' as const, canFanOut: false, sampling: false, elicitation: { form: true, url: true } }
const context = (state?: unknown, answer?: unknown) => ({ sessionId: 'test-review', mcpReq: { requestState: () => state, inputResponses: { answer } } }) as unknown as ServerContext
const value = (result: CallToolResult | InputRequiredResult) => JSON.parse((result.content as Array<{ text: string }>)[0].text)
const args = { runId: 'run1', review_revision: 'a'.repeat(64) }
function fixture(supported = true) {
  const review = { ...args, feature: 'checkout', files: [{ file: 'e2e/a.spec.ts', change: 'modified' }], patchPath: '/review.patch', patch: '-before\n+after', canAdopt: true }
  const send = vi.fn(async (request: { method: string; payload?: unknown }) => ({ statusCode: 200, body: request.method === 'GET' ? review : {
    decision: 'accepted', review_revision: args.review_revision, files: ['e2e/a.spec.ts'], at: 'now',
    git: { status: 'committed', commit: 'abc' }, execution: { status: 'rerun-requested', runId: args.runId },
  } }))
  const tools = captureTools(registerTestReviewTools, { projectRoot: '/project', testReviewRequest: send, getUiUrl: () => 'http://localhost:1234' }, supported ? facts : { ...facts, elicitation: { form: false, url: false } })
  return { review, send, tools }
}

describe('test review human gate', () => {
  it.each(['internal', 'external'])('keeps %s continuation instructions and nextSteps consistent after restoration', async (kind) => {
    const { tools, send } = fixture()
    const base = send.getMockImplementation()!
    send.mockImplementation(async (request) => {
      if ((request as { url?: string }).url === '/api/run-requests/request1') return { statusCode: 200, body: {
        requestId: 'request1', feature: 'checkout', status: 'ready', review: { runId: args.runId, revision: args.review_revision },
        owner: kind === 'internal' ? { kind } : { kind, sessionId: 'owner-session', clientKind: 'codex' },
      } } as never
      if (request.method === 'POST') return { statusCode: 200, body: { decision: 'restored', execution: { status: 'none' } } } as never
      return base(request)
    })
    const parameters = { ...args, request_id: 'request1' }
    const opened = await tools.raw('review_test_changes', parameters, context()) as InputRequiredResult
    const result = value(await tools.raw('review_test_changes', parameters, context(opened.requestState, {
      action: 'accept', content: { choice: 'Restore recorded files' },
    })))
    expect(result.nextSteps).toEqual(kind === 'external' ? ['start_run'] : [])
    expect(result.next).toContain(kind === 'external' ? 'owner-session' : 'do not start another run')
    expect(result.nextSteps).not.toContain('wait_for_heal_task')
  })
  it('returns the exact patch and a deep link without adopting', async () => {
    const { tools, send } = fixture()
    const result = await tools.call('get_test_review', { runId: 'run1' })
    expect(result.patch).toBe('-before\n+after')
    expect(result.reviewUrl).toContain('reviewBase=run')
    expect(result.reviewUrl).toContain('run=run1')
    expect(send.mock.calls.every(([request]) => request.method === 'GET')).toBe(true)
    expect(tools.configs.get('review_test_changes')?.inputSchema).not.toHaveProperty('confirm')
    expect(tools.configs.get('review_test_changes')?.inputSchema).not.toHaveProperty('choice')
  })

  it('only adopts after human acceptance and does not apply a replay twice', async () => {
    const { tools, send } = fixture()
    const opened = await tools.raw('review_test_changes', { ...args, confirm: true, choice: 'Accept & commit' }, context()) as InputRequiredResult
    expect(opened.inputRequests).toMatchObject({ answer: { method: 'elicitation/create' } })
    expect(send.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(0)
    const accepted = context(opened.requestState, { action: 'accept', content: { choice: 'Accept & commit' } })
    const first = await tools.raw('review_test_changes', args, accepted)
    expect(value(first)).toMatchObject({ status: 'adopted', review_revision: args.review_revision })
    expect(await tools.raw('review_test_changes', args, accepted)).toEqual(first)
    expect(send.mock.calls.filter(([r]) => r.method === 'POST')).toEqual([[expect.objectContaining({ payload: { expectedRevision: args.review_revision } })]])
  })

  it.each(['cancel', 'decline'])('leaves changes untouched for %s', async (decision) => {
    const { tools, send } = fixture()
    const opened = await tools.raw('review_test_changes', args, context()) as InputRequiredResult
    const answer = { action: decision }
    expect(value(await tools.raw('review_test_changes', args, context(opened.requestState, answer)))).toMatchObject({ status: 'needs-input' })
    expect(send.mock.calls.some(([r]) => r.method === 'POST')).toBe(false)
  })

  it('rejects an approval when the suite changed while the form was open', async () => {
    const { tools, send, review } = fixture()
    const opened = await tools.raw('review_test_changes', args, context()) as InputRequiredResult
    review.review_revision = 'b'.repeat(64)
    expect(value(await tools.raw('review_test_changes', args, context(opened.requestState, { action: 'accept', content: { choice: 'Accept & commit' } })))).toMatchObject({ status: 'needs-input', reason: expect.stringContaining('changed') })
    expect(send.mock.calls.some(([r]) => r.method === 'POST')).toBe(false)
  })

  it('does not let a forged or cross-run request state approve', async () => {
    const { tools, send } = fixture()
    const answer = { action: 'accept', content: { choice: 'Accept & commit' } }
    expect(value(await tools.raw('review_test_changes', args, context('forged', answer))).status).toBe('needs-input')
    const opened = await tools.raw('review_test_changes', args, context()) as InputRequiredResult
    expect(value(await tools.raw('review_test_changes', { ...args, runId: 'other' }, context(opened.requestState, answer))).status).toBe('needs-input')
    expect(send.mock.calls.some(([r]) => r.method === 'POST')).toBe(false)
  })

  it('leaves unsupported clients on the human UI flow, even if confirm is supplied', async () => {
    const { tools, send } = fixture(false)
    expect(value(await tools.raw('review_test_changes', { ...args, confirm: true }, context()))).toMatchObject({ reason: 'elicitation-unavailable', reviewUrl: expect.stringContaining('tests-review') })
    expect(send.mock.calls.some(([r]) => r.method === 'POST')).toBe(false)
  })

  it('reports inactive runs and empty reviews without an adoption prompt', async () => {
    const { tools, review } = fixture()
    review.canAdopt = false
    expect((await tools.call('get_test_review', args)).next).toContain('start_run(run_ref)')
    expect(value(await tools.raw('review_test_changes', args, context())).reason).toContain('no longer active')
    review.canAdopt = true
    review.files = []
    expect(value(await tools.raw('review_test_changes', args, context())).status).toBe('no-changes')
  })

  it.each(['get_test_review', 'review_test_changes'])('%s reports missing dependencies and route errors', async (tool) => {
    const missing = captureTools(registerTestReviewTools, {})
    expect((await missing.raw(tool, args)).isError).toBe(true)
    const { tools, send } = fixture()
    send.mockResolvedValueOnce({ statusCode: 409, body: { error: 'snapshot unavailable' } } as never)
    expect((await tools.raw(tool, args)).isError).toBe(true)
  })

  it('reports adoption rejection after the final route revision check', async () => {
    const { tools, send } = fixture()
    const opened = await tools.raw('review_test_changes', args, context()) as InputRequiredResult
    const read = send.getMockImplementation()!
    send.mockImplementation(async (request) => request.method === 'GET' ? read(request) : { statusCode: 409, body: { reason: 'review-changed' } } as never)
    expect((await tools.raw('review_test_changes', args, context(opened.requestState, { action: 'accept', content: { choice: 'Accept & commit' } }))).isError).toBe(true)
  })

  it('approves a terminal candidate for a new run without steering back to the ended run', async () => {
    const { tools, send, review } = fixture()
    Object.assign(review, {
      canAdopt: false,
      reviewState: 'pending-terminal',
      allowedActions: ['approve-new-run', 'restore', 'leave-pending'],
      nextAction: 'restore-or-leave',
    })
    const read = send.getMockImplementation()!
    send.mockImplementation(async (request) => request.method === 'GET'
      ? read(request)
      : { statusCode: 202, body: {
          decision: 'accepted', review_revision: args.review_revision, files: ['e2e/a.spec.ts'], at: 'now',
          git: { status: 'committed', commit: 'abc' }, execution: { status: 'new-run-required', runId: args.runId },
        } } as never)
    expect((await tools.call('get_test_review', args)).next).toContain('new run')
    const opened = await tools.raw('review_test_changes', args, context()) as InputRequiredResult
    const result = value(await tools.raw('review_test_changes', args, context(opened.requestState, {
      action: 'accept', content: { choice: 'Accept & commit' },
    })))
    expect(result).toMatchObject({ status: 'approved-for-new-run', nextSteps: ['start_run'] })
    expect(result).not.toHaveProperty('nextSteps.0', 'wait_for_heal_task')
  })

  it('works without a browser URL and directs unsupported clients to the UI', async () => {
    const { send } = fixture()
    const tools = captureTools(registerTestReviewTools, { testReviewRequest: send })
    expect(await tools.call('get_test_review', args)).not.toHaveProperty('reviewUrl')
    expect(value(await tools.raw('review_test_changes', args)).reason).toBe('elicitation-unavailable')
  })
})
