import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { suiteReviewRevision } from '../../features/runs/logic/runtime/suite-review'
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
        requestId: 'request1', feature: 'checkout', status: kind === 'external' ? 'cancelled' : 'ready', review: { runId: args.runId, revision: args.review_revision },
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
    expect(result.nextSteps).toEqual([])
    expect(result.next).toContain(kind === 'external' ? 'Stop waiting and do not start a run' : 'do not start another run')
    expect(result.nextSteps).not.toContain('wait_for_heal_task')
  })

  it.each([
    ['started', { status: 'started' }, 'Continue that run'],
    ['queued', { status: 'queued' }, 'Continue that run'],
    ['awaiting review', { status: 'awaiting-review' }, 'Show the review evidence'],
    ['failed with an error', { status: 'failed', error: 'runner stopped' }, 'runner stopped'],
    ['failed without an error', { status: 'failed' }, 'Do not start a replacement implicitly'],
  ])('describes a %s continuation without starting a replacement', async (_name, requestState, expected) => {
    const { tools, send } = fixture()
    const fallback = send.getMockImplementation()!
    send.mockImplementation(async (request) => {
      if ((request as { url?: string }).url === '/api/run-requests/request1') return { statusCode: 200, body: {
        requestId: 'request1', feature: 'checkout', runId: args.runId, review: { runId: args.runId, revision: args.review_revision },
        owner: { kind: 'internal' }, ...requestState,
      } } as never
      return fallback(request)
    })

    const result = await tools.call('get_test_review', { runId: args.runId, request_id: 'request1' })
    expect(String(result.next)).toContain(expected)
    expect(result.request_id).toBe('request1')
  })

  it('keeps a missing or cross-run continuation explicit rather than guessing a replacement', async () => {
    const { tools, send } = fixture()
    const fallback = send.getMockImplementation()!
    send.mockImplementation(async (request) => {
      if ((request as { url?: string }).url === '/api/run-requests/missing') return { statusCode: 404, body: {} } as never
      if ((request as { url?: string }).url === '/api/run-requests/wrong') return { statusCode: 200, body: {
        requestId: 'wrong', feature: 'checkout', runId: 'another-run', review: { runId: 'another-run', revision: args.review_revision }, owner: { kind: 'internal' }, status: 'ready',
      } } as never
      return fallback(request)
    })

    expect(await tools.call('get_test_review', { runId: args.runId, request_id: 'missing' })).toMatchObject({ continuationError: expect.stringContaining('unavailable') })
    expect(await tools.call('get_test_review', { runId: args.runId, request_id: 'wrong' })).toMatchObject({ continuationError: expect.stringContaining('different review') })
  })

  it('returns a persisted review decision before consulting the review route', async () => {
    const store = { get: () => ({ manifest: { status: 'healing', specEdits: { reviewDecisions: [{
      revision: args.review_revision, decision: 'adopted', receipt: { decision: 'accepted', review_revision: args.review_revision, files: [], at: 'now', git: { status: 'not-requested' }, execution: { status: 'none' } },
    }] } } }) }
    const tools = captureTools(registerTestReviewTools, { projectRoot: '/project', store })

    expect(value(await tools.raw('review_test_changes', args))).toMatchObject({ status: 'adopted', runId: args.runId })
  })

  it('keeps an unchanged browser wait tied to its original request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-wait-tool-'))
    try {
      const suite = path.join(root, 'suite')
      const feature = path.join(root, 'feature')
      for (const dir of [suite, feature]) fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
      fs.writeFileSync(path.join(suite, 'e2e/a.spec.ts'), 'recorded\n')
      fs.writeFileSync(path.join(feature, 'e2e/a.spec.ts'), 'candidate\n')
      const revision = suiteReviewRevision(suite, feature)
      const listeners: Array<(event: unknown) => void> = []
      const store = {
        get: () => ({ manifest: { status: 'healing', featureDir: feature, suiteSnapshot: { kind: 'taken', dir: suite }, specEdits: { reviewDecisions: [] } } }),
        onEvent: (listener: (event: unknown) => void) => { listeners.push(listener) },
        offEvent: (listener: (event: unknown) => void) => { listeners.splice(listeners.indexOf(listener), 1) },
      }
      const review = { ...args, review_revision: revision, feature: 'checkout', files: [{ file: 'e2e/a.spec.ts', change: 'modified' }], patchPath: '/review.patch', canAdopt: true }
      let requestStatus: 'awaiting-review' | 'ready' = 'awaiting-review'
      const send = vi.fn(async (request: { url: string }) => request.url === '/api/run-requests/request1'
        ? { statusCode: 200, body: { requestId: 'request1', feature: 'checkout', runId: args.runId, review: { runId: args.runId, revision }, owner: { kind: 'internal' }, status: requestStatus } }
        : { statusCode: 200, body: review })
      const tools = captureTools(registerTestReviewTools, { projectRoot: '/project', store, testReviewRequest: send })
      const opened = await tools.call('get_test_review', { runId: args.runId })

      const waited = value(await tools.raw('review_test_changes', {
        ...args, review_revision: revision, request_id: 'request1', wait_for_decision: true, browser_wait_token: opened.browser_wait_token, timeout_ms: 1,
      }))
      expect(waited).toMatchObject({ status: 'still_waiting', request_id: 'request1' })
      expect(String(waited.next)).toContain('Carry the original request_id')
      expect(listeners).toHaveLength(0)
      fs.writeFileSync(path.join(feature, 'e2e/a.spec.ts'), 'different candidate\n')
      requestStatus = 'ready'
      const changed = value(await tools.raw('review_test_changes', {
        ...args, review_revision: revision, request_id: 'request1', wait_for_decision: true, browser_wait_token: opened.browser_wait_token, timeout_ms: 1,
      }))
      expect(changed).toMatchObject({ status: 'review-changed', nextSteps: ['get_test_review'] })
      expect(changed.next).toContain('Stop this watcher')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
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

  it('offers a browser watcher to a Codex client without forms for the saved request', async () => {
    const { tools, send } = fixture(false)
    const result = value(await tools.raw('review_test_changes', { ...args, request_id: 'request1' }, context()))
    expect(result).toMatchObject({ status: 'needs-input', reason: 'elicitation-unavailable',
      request_id: 'request1', nextSteps: ['get_test_review', 'review_test_changes'] })
    expect(result.next).toContain('background agent')
    expect(send.mock.calls.some(([request]) => request.method === 'POST')).toBe(false)
  })

  it.each(['decline', 'cancel'] as const)('hands a %s response to a read-only watcher without claiming a human decision', async (action) => {
    const { tools, send } = fixture()
    const original = send.getMockImplementation()!
    send.mockImplementation(async (request) => {
      if ((request as { url?: string }).url === '/api/run-requests/request1') return { statusCode: 200, body: {
        requestId: 'request1', feature: 'checkout', status: 'awaiting-review',
        review: { runId: args.runId, revision: args.review_revision },
        owner: { kind: 'external', sessionId: 'original-session', clientKind: 'codex' },
      } } as never
      return original(request)
    })
    const parameters = { ...args, request_id: 'request1' }
    const opened = await tools.raw('review_test_changes', parameters, context()) as InputRequiredResult
    const result = value(await tools.raw('review_test_changes', parameters, context(opened.requestState, { action })))
    expect(result).toMatchObject({ status: 'needs-input', request_id: 'request1',
      request: { status: 'awaiting-review', owner: { sessionId: 'original-session' } },
      browser_wait_token: expect.any(String), nextSteps: ['get_test_review', 'review_test_changes'] })
    expect(result.reason).toContain(`client answered "${action}"`)
    expect(result.next).toContain('background agent')
    expect(send.mock.calls.some(([request]) => request.method === 'POST')).toBe(false)
  })

  it('tells Desktop\'s Code tab that nothing was shown, then keeps the approval rule verbatim', async () => {
    // The client observed live behind Desktop's Code tab: `local-agent-mode-<server>`,
    // no elicitation declared at all. The fallback must name that limitation AND
    // still carry every sentence of the approval rule — a browser click, a Git
    // commit, or a restart is never approval, whichever client asked.
    const { send } = fixture()
    const desktop = { surface: 'claude-code' as const, name: 'local-agent-mode-Canary_Lab', canFanOut: true, sampling: false }
    const desktopTools = captureTools(registerTestReviewTools, { projectRoot: '/project', testReviewRequest: send, getUiUrl: () => 'http://localhost:1234' }, desktop)
    const result = value(await desktopTools.raw('review_test_changes', args, context()))
    expect(result).toMatchObject({ status: 'needs-input', reason: 'elicitation-unavailable', browser_wait_token: expect.any(String) })
    expect(result.next).toMatch(/^Claude Desktop's local agent mode \(Code tab\) presents no MCP forms/)
    expect(result.next).toContain('Report that limitation, not that the human declined or has not decided.')
    expect(result.next).toContain('Do not click approval controls yourself. Never infer approval from a Git commit or restart.')
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

  it('renders a settled review and refuses a pending review with no allowed action', async () => {
    const { tools, review } = fixture()
    Object.assign(review, { canAdopt: false, reviewState: 'settled', allowedActions: [], nextAction: 'none', files: [] })
    expect((await tools.call('get_test_review', args)).next).toContain('already settled')
    expect(value(await tools.raw('review_test_changes', args, context())).reason).toContain('no available decision action')
  })
})
