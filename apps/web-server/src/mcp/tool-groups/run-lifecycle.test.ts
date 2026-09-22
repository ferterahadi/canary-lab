import { describe, expect, it, vi } from 'vitest'
import type { RunDetail } from '../../features/runs/logic/run-store'
import { CLAIM_SUPPRESSED_MESSAGE } from '../tool-support'
import type { InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import type { McpClientFacts } from '../client-surface'
import { registerRunLifecycleTools } from './run-lifecycle'
import { captureTools } from './__fixtures__/tool-group-harness'

// The run-lifecycle tools: start_run's four-way entrypoint (continue a healing
// run / resolve a run_ref / restart a failed run / start fresh), boot_services,
// and the three orchestrator pokes (pause, cancel heal, abort).
//
// Two things here are load-bearing rather than incidental.
//
// First, the harness calls the registered handlers directly, so zod NEVER runs
// and none of the schema defaults are applied. Every start_run case therefore
// states `claim_heal` and `force_new` explicitly — omitting one would send
// `undefined` (falsy) rather than the declared default, and the suite would
// quietly test the opposite branch from the one it names.
//
// Second, the restart result's counts must come off the stored summary. The
// fixture deliberately has a known test that never ran, so a regression to
// `total - failed` shows up as `passed: 2` instead of `passed: 1, notRun: 1`.

const START = {
  feature: 'checkout',
  claim_heal: true,
  session_id: 'sess-1',
  client_kind: 'claude',
  force_new: false,
}

function runDetail(manifest: Record<string, unknown> = {}, over: Record<string, unknown> = {}): RunDetail {
  return {
    runId: 'run-1',
    manifest: {
      runId: 'run-1', feature: 'checkout', env: 'local',
      startedAt: '2026-05-25T08:00:00.000Z', status: 'running',
      healCycles: 0, services: [],
      ...manifest,
    },
    summary: { complete: false, total: 1, passed: 0, failed: [] },
    ...over,
  } as unknown as RunDetail
}

function storeOf(details: RunDetail[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    list: () => details.map((d) => ({
      runId: d.manifest.runId,
      status: d.manifest.status,
      startedAt: d.manifest.startedAt,
    })),
    get: (runId: string) => details.find((d) => d.manifest.runId === runId),
    registry: { get: () => undefined },
    abort: async () => ({ ok: true }),
    ...over,
  }
}

function harness(over: Record<string, unknown> = {}, facts?: McpClientFacts) {
  const claims: Array<Record<string, unknown>> = []
  const tools = captureTools(registerRunLifecycleTools, {
    store: storeOf([]),
    broker: {
      claim: (runId: string, session: Record<string, unknown>) => {
        claims.push({ runId, ...session })
        return { accepted: true, session }
      },
    },
    startRun: async () => ({ kind: 'started', runId: 'run-new' }),
    ...over,
  }, facts)
  return { ...tools, claims }
}

// The default harness client has no elicitation, which is why every collision
// case above reads as the chat fallback. These two drive the other half: a client
// that CAN show the form, and the answering call that comes back with a choice.
const eliciting: McpClientFacts = { surface: 'codex', canFanOut: false, sampling: false, elicitation: { form: true, url: false } }
const context = (state?: unknown, answer?: unknown) => ({ sessionId: 'run-lifecycle', mcpReq: { requestState: () => state, inputResponses: { answer } } }) as unknown as ServerContext
const collision = {
  kind: 'collision', conflictingRunId: 'run-9', conflictingFeature: 'search',
  repoPaths: ['/repo/shop'], options: ['worktree', 'queue'], message: 'run-9 is using /repo/shop',
}

function coverageChange(
  state: 'current' | 'stale' = 'stale',
  revision = 'coverage-v1',
  over: Record<string, unknown> = {},
) {
  return {
    changed: true,
    change: {
      feature: 'checkout',
      freshness: {
        revision,
        state,
        reasons: state === 'stale' ? ['2 test inputs changed since coverage was mapped.'] : [],
        changedTests: state === 'stale' ? ['checkout.spec.ts', 'refund.spec.ts'] : [],
        latestRunFailed: false,
        proofNeedsRun: state === 'current',
        nextAction: state === 'stale'
          ? { stage: 'specs-coverage', label: 'Update coverage mappings', command: 'start_external_coverage', arguments: { feature: 'checkout' } }
          : { stage: 'run', label: 'Verify current tests', command: 'start_run', arguments: { feature: 'checkout' } },
      },
      delivery: 'tool-response-and-wait',
      ...over,
    },
  }
}

const coverageRequest = (body = coverageChange()) => vi.fn(async () => ({ statusCode: 200, body }))

describe.each([
  ['start_run', START, 'run-new'],
  ['boot_services', { feature: 'checkout' }, 'boot-1'],
] as const)('%s: answering the isolation question', (tool, args, runId) => {
  it('starts nothing until the choice arrives, then starts with it', async () => {
    const startRun = vi.fn(async (_f: string, _e: unknown, _r: unknown, isolation?: string) =>
      isolation ? { kind: 'started', runId, booted: true } : collision)
    const { raw } = harness({ startRun }, eliciting)
    const opened = await raw(tool, args, context()) as InputRequiredResult
    expect(opened.inputRequests).toMatchObject({ answer: { params: { message: expect.stringContaining('run-9 is using /repo/shop'), requestedSchema: { properties: { isolation: { enum: ['worktree', 'queue'] } } } } } })
    expect(startRun.mock.calls.every((callArgs) => callArgs[3] === undefined)).toBe(true)

    const answered = await raw(tool, args, context(opened.requestState, { action: 'accept', content: { isolation: 'worktree' } }))
    expect(JSON.parse((answered.content as Array<{ text: string }>)[0].text)).toMatchObject({ runId })
    expect(startRun.mock.lastCall?.[0]).toBe('checkout')
    expect(startRun.mock.lastCall?.[3]).toBe('worktree')
  })

  it('leaves the work pending when the answer belongs to another question', async () => {
    const startRun = vi.fn(async () => collision)
    const { raw } = harness({ startRun }, eliciting)
    const forged = await raw(tool, args, context('not-a-real-handle', { action: 'accept', content: { isolation: 'queue' } }))
    expect(JSON.parse((forged.content as Array<{ text: string }>)[0].text)).toMatchObject({ status: 'needs-input', reason: expect.stringContaining('belongs to a different operation') })
    expect(startRun).not.toHaveBeenCalled()
  })
})

describe('start_run: continuing the run that is already healing', () => {
  it('resumes a durable request only through the original session route and does not create a new start', async () => {
    const startRun = vi.fn()
    const testReviewRequest = vi.fn(async () => ({ statusCode: 200, body: { runId: 'continued', request: { status: 'started' } } }))
    const { call } = harness({ startRun, testReviewRequest })
    expect(await call('start_run', { ...START, request_id: 'request-1' })).toMatchObject({ runId: 'continued', nextSteps: ['get_run'] })
    expect(testReviewRequest).toHaveBeenCalledWith({ method: 'POST', url: '/api/run-requests/request-1/resume', payload: { sessionId: START.session_id } })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('keeps a failed request continuation as a route result and never starts a replacement', async () => {
    const startRun = vi.fn()
    const { call } = harness({ startRun, testReviewRequest: async () => ({ statusCode: 409, body: { reason: 'review-changed' } }) })

    expect(await call('start_run', { ...START, request_id: 'request-1' })).toEqual({ reason: 'review-changed' })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('reports when a request continuation is unavailable before a replacement can start', async () => {
    const startRun = vi.fn()
    const { text } = harness({ startRun })

    expect(await text('start_run', { ...START, request_id: 'request-1' })).toBe('Run-request continuation is unavailable on this server.')
    expect(startRun).not.toHaveBeenCalled()
  })

  it('preserves a structured review blocker and its original request identity', async () => {
    const review = { type: 'test_review_required', runId: 'source', review_revision: 'a'.repeat(64), request: { requestId: 'request-1' } }
    const { call } = harness({ startRun: async () => { throw Object.assign(new Error('review needed'), { testReviewRequired: review }) } })
    expect(await call('start_run', START)).toMatchObject({ ...review, runStarted: false, request_id: 'request-1' })
  })

  it('keeps a review blocker actionable even when it has no resumable request', async () => {
    const review = { type: 'test_review_required', runId: 'source', review_revision: 'a'.repeat(64) }
    const { call } = harness({ startRun: async () => { throw Object.assign(new Error('review needed'), { testReviewRequired: review }) } })

    const result = await call('start_run', START)
    expect(result).toMatchObject({ ...review, runStarted: false })
    expect(result).not.toHaveProperty('request_id')
  })

  it('does not gate reuse on current coverage freshness', async () => {
    const read = coverageRequest()
    const { call } = harness({ store: storeOf([runDetail({ status: 'healing' })]), coverageRequest: read })

    expect(await call('start_run', START)).toMatchObject({ runId: 'run-1', reused: true })
    expect(read).not.toHaveBeenCalled()
  })

  it('reuses it, claims heal for this session, and says to wait for the task', async () => {
    const startRun = vi.fn()
    const { call, claims } = harness({
      store: storeOf([runDetail({ status: 'healing' })]),
      startRun,
    })

    const out = await call('start_run', { ...START, conversation_name: 'fix checkout' })

    expect(out).toEqual({
      runId: 'run-1',
      reused: true,
      status: 'healing',
      claimed: true,
      claim: { accepted: true, session: { sessionId: 'sess-1', clientKind: 'claude', conversationName: 'fix checkout' } },
      nextSteps: ['wait_for_heal_task'],
    })
    // Continuing is the whole point of the default path: a second run would
    // leave the first one healing with nobody driving it.
    expect(startRun).not.toHaveBeenCalled()
    expect(claims).toEqual([{ runId: 'run-1', sessionId: 'sess-1', clientKind: 'claude', conversationName: 'fix checkout' }])
  })

  it('down-shifts the claim for a runner-spawned PTY agent instead of taking heal duty behind its back', async () => {
    const { call, claims } = harness({ store: storeOf([runDetail({ status: 'healing' })]) })

    const out = await call('start_run', { ...START, client_kind: 'claude-pty' })

    // Blocked clients still get the run — they just don't own its loop, and are
    // told so rather than left to assume they do.
    expect(out).toEqual({
      runId: 'run-1',
      reused: true,
      status: 'healing',
      claimed: false,
      claim: null,
      claimSuppressed: true,
      message: CLAIM_SUPPRESSED_MESSAGE,
    })
    expect(out).not.toHaveProperty('nextSteps')
    expect(claims).toEqual([])
  })

  it('reports a claim the broker refused rather than calling the run claimed', async () => {
    const currentSession = { sessionId: 'sess-other', clientKind: 'codex' }
    const { call } = harness({
      store: storeOf([runDetail({ status: 'healing' })]),
      broker: { claim: () => ({ accepted: false, reason: 'already-claimed', currentSession }) },
    })

    const out = await call('start_run', START)

    expect(out).toMatchObject({
      claimed: false,
      claim: { accepted: false, reason: 'already-claimed', currentSession },
    })
  })

  it('claims nothing, and posts no suppression notice, when the caller opted out', async () => {
    const { call, claims } = harness({ store: storeOf([runDetail({ status: 'healing' })]) })

    const out = await call('start_run', { ...START, claim_heal: false })

    // Opting out is not the same as being blocked: no claim, and no message
    // explaining a block that didn't happen.
    expect(out).toEqual({ runId: 'run-1', reused: true, status: 'healing', claimed: false, claim: null })
    expect(claims).toEqual([])
  })

  it('keeps the existing repair and journal even when an agent asks for force_new', async () => {
    const startRun = vi.fn()
    const { call } = harness({ store: storeOf([runDetail({ status: 'healing' })]), startRun })

    expect(await call('start_run', { ...START, force_new: true }))
      .toMatchObject({ runId: 'run-1', reused: true, freshStartBlocked: true, nextSteps: ['wait_for_heal_task'] })
    expect(startRun).not.toHaveBeenCalled()
  })
})

describe('start_run: resolving a run reference', () => {
  it('names the ref it could not find', async () => {
    const { text } = harness()

    expect(await text('start_run', { ...START, run_ref: '7cvh' })).toBe('run-not-found: 7cvh')
  })

  it('lists the candidates when a suffix matches more than one run', async () => {
    const store = storeOf([
      runDetail({ runId: 'run-aa-7cvh', status: 'failed', endedAt: '2026-05-25T08:10:00.000Z' }),
      runDetail({ runId: 'run-bb-7cvh', status: 'aborted' }),
    ])
    const { call } = harness({ store })

    const out = await call('start_run', { ...START, run_ref: '7cvh' })

    expect(out).toEqual({
      type: 'ambiguous_run_ref',
      run_ref: '7cvh',
      candidates: [
        { runId: 'run-aa-7cvh', executionType: 'run', feature: 'checkout', env: 'local', status: 'failed', startedAt: '2026-05-25T08:00:00.000Z', endedAt: '2026-05-25T08:10:00.000Z' },
        { runId: 'run-bb-7cvh', executionType: 'run', feature: 'checkout', env: 'local', status: 'aborted', startedAt: '2026-05-25T08:00:00.000Z', endedAt: null },
      ],
    })
  })

  it('follows a held boot session without claiming heal or sending the caller to wait', async () => {
    const { call, claims } = harness({
      store: storeOf([runDetail({ executionType: 'boot', status: 'running' })]),
    })

    const out = await call('start_run', { ...START, run_ref: 'run-1' })

    // A boot session runs no tests and has no heal loop, so waiting on one
    // would dead-block until the timeout.
    expect(out).toMatchObject({ type: 'boot_session', runId: 'run-1', reused: true, claimed: false })
    expect(out.nextSteps).not.toContain('wait_for_heal_task')
    expect(claims).toEqual([])
  })

  it('resumes an active run addressed by exact runId', async () => {
    const { call } = harness({ store: storeOf([runDetail({ status: 'running' })]) })

    expect(await call('start_run', { ...START, runId: 'run-1' })).toMatchObject({
      runId: 'run-1',
      reused: true,
      status: 'running',
      claimed: true,
      nextSteps: ['wait_for_heal_task'],
    })
  })

  it('resumes an active run without a claim for a blocked client', async () => {
    const { call } = harness({ store: storeOf([runDetail({ status: 'running' })]) })

    expect(await call('start_run', { ...START, runId: 'run-1', client_kind: 'codex-pty' }))
      .toMatchObject({ reused: true, claimed: false, claim: null, claimSuppressed: true })
  })

  it('refuses to restart a passed run, and says how to test again', async () => {
    const { call } = harness({ store: storeOf([runDetail({ status: 'passed' })]) })

    const out = await call('start_run', { ...START, run_ref: 'run-1' })

    expect(out).toMatchObject({ type: 'not_restartable', runId: 'run-1', status: 'passed' })
    expect(String(out.message)).toContain('without runId/run_ref')
  })

  it('refuses a queued run, which has nothing to restart from yet', async () => {
    const { text } = harness({ store: storeOf([runDetail({ status: 'queued' })]) })

    expect(await text('start_run', { ...START, run_ref: 'run-1' }))
      .toBe('run-not-restartable: run-1 status=queued')
  })
})

describe('start_run: restarting a failed run in remaining-test mode', () => {
  // A three-test suite that stopped after one failure: one pass, one fail, one
  // never reached. `notRun` has to survive into the result.
  const summary = {
    complete: true,
    total: 3,
    passed: 1,
    passedNames: ['pays with card'],
    failed: [{ name: 'applies a promo' }],
    knownTests: [{ name: 'pays with card' }, { name: 'applies a promo' }, { name: 'refunds an order' }],
  }

  it('does not gate a recorded failed-run restart on current coverage freshness', async () => {
    const read = coverageRequest()
    const restartExternalRun = vi.fn(async () => ({ runId: 'run-1', mode: 'remaining' as const }))
    const { call } = harness({
      store: storeOf([runDetail({ status: 'failed' }, { summary })]),
      coverageRequest: read,
      restartExternalRun,
    })

    expect(await call('start_run', { ...START, run_ref: 'run-1' })).toMatchObject({ restarted: true })
    expect(read).not.toHaveBeenCalled()
  })

  it('says so when the restarter is not wired', async () => {
    const { text } = harness({ store: storeOf([runDetail({ status: 'failed' })]) })

    expect(await text('start_run', { ...START, run_ref: 'run-1' }))
      .toBe('restartExternalRun dependency is not configured')
  })

  it('restarts it, claims the new run, and reports counts read off the summary', async () => {
    const restartExternalRun = vi.fn(async () => ({ runId: 'run-1', mode: 'remaining' as const }))
    const { call } = harness({
      store: storeOf([runDetail({ status: 'failed' }, { summary })]),
      restartExternalRun,
    })

    const out = await call('start_run', {
      ...START, run_ref: 'run-1', conversation_name: 'fix checkout', guidance: 'the promo code is case-sensitive',
    })

    expect(out).toMatchObject({
      runId: 'run-1',
      reused: true,
      restarted: true,
      mode: 'remaining',
      status: 'running',
      claimed: true,
      statusLine: '1/3 passed, 1 failed, 1 not run',
      nextSteps: ['wait_for_heal_task'],
    })
    // The never-reached test stays never-reached. Deriving passed as
    // total - failed would report it as a second pass.
    expect(out.counts).toMatchObject({ totalKnown: 3, passed: 1, failed: 1, notRun: 1, notRunNames: ['refunds an order'] })
    expect(restartExternalRun).toHaveBeenCalledWith(
      'run-1',
      { kind: 'external', sessionId: 'sess-1', clientKind: 'claude', conversationName: 'fix checkout', claimable: true },
      'the promo code is case-sensitive',
    )
  })

  it('defaults the mode, and zeroes the counts, when neither is on record', async () => {
    const restartExternalRun = vi.fn(async () => ({ runId: 'run-2' }))
    const { call } = harness({
      store: storeOf([runDetail({ runId: 'run-1', status: 'aborted' }, { summary: undefined })]),
      restartExternalRun,
    })

    const out = await call('start_run', { ...START, run_ref: 'run-1' })

    expect(out).toMatchObject({ runId: 'run-2', mode: 'remaining', statusLine: '0/0 passed, 0 failed, 0 not run' })
    // No conversation_name supplied: the field is omitted rather than sent undefined.
    expect(restartExternalRun).toHaveBeenCalledWith(
      'run-1',
      { kind: 'external', sessionId: 'sess-1', clientKind: 'claude', claimable: true },
      undefined,
    )
  })

  it('restarts into external mode with claimable:false for a blocked client', async () => {
    const restartExternalRun = vi.fn(async () => ({ runId: 'run-1' }))
    const { call, claims } = harness({
      store: storeOf([runDetail({ status: 'failed' }, { summary })]),
      restartExternalRun,
    })

    const out = await call('start_run', { ...START, run_ref: 'run-1', client_kind: 'codex-pty' })

    // `claimable: false` is what makes the restart wait for a Desktop/UI drive
    // instead of restarting into a session that cannot own the loop.
    expect(restartExternalRun).toHaveBeenCalledWith(
      'run-1',
      { kind: 'external', sessionId: 'sess-1', clientKind: 'codex-pty', claimable: false },
      undefined,
    )
    expect(out).toMatchObject({ restarted: true, claimed: false, claim: null, claimSuppressed: true })
    expect(claims).toEqual([])
  })
})

describe('start_run: starting fresh', () => {
  it('starts nothing and tells a form-less client to ask when coverage mapping is stale', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const { call } = harness({ startRun, coverageRequest: coverageRequest() })

    expect(await call('start_run', START)).toMatchObject({
      type: 'coverage_update_requires_choice',
      runStarted: false,
      feature: 'checkout',
      options: ['Update coverage first', 'Run now with stale coverage'],
    })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('elicits stale coverage and leaves the run stopped when the user chooses the update', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const { raw } = harness({ startRun, coverageRequest: coverageRequest() }, eliciting)

    const opened = await raw('start_run', START, context()) as InputRequiredResult
    expect(opened.inputRequests).toMatchObject({ answer: { params: {
      message: expect.stringContaining('Previous coverage percentages do not describe the current tests'),
      requestedSchema: { properties: { choice: { enum: ['Update coverage first', 'Run now with stale coverage'] } } },
    } } })
    const answered = await raw('start_run', START, context(opened.requestState, {
      action: 'accept', content: { choice: 'Update coverage first' },
    }))

    expect(JSON.parse((answered.content as Array<{ text: string }>)[0].text)).toMatchObject({
      type: 'coverage_update_required', runStarted: false,
    })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('points update-first at the existing coverage owner instead of duplicating work', async () => {
    const body = coverageChange('stale', 'coverage-v1', { activeJobId: 'coverage-job-1', activeJobOwner: 'session-2' })
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const { raw } = harness({ startRun, coverageRequest: coverageRequest(body) }, eliciting)
    const opened = await raw('start_run', START, context()) as InputRequiredResult

    const answered = await raw('start_run', START, context(opened.requestState, {
      action: 'accept', content: { choice: 'Update coverage first' },
    }))
    const result = JSON.parse((answered.content as Array<{ text: string }>)[0].text)

    expect(result).toMatchObject({
      type: 'coverage_update_required', activeJobId: 'coverage-job-1', activeJobOwner: 'session-2',
      nextSteps: ['follow the existing coverage owner', 'confirm coverage freshness', 'retry start_run'],
    })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('identifies a flight owner and an ownerless active coverage job without duplicating either', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    for (const body of [
      coverageChange('stale', 'coverage-flight', { flightId: 'flight-1', flightStatus: 'running' }),
      coverageChange('stale', 'coverage-job', { activeJobId: 'coverage-job-1' }),
    ]) {
      const { raw } = harness({ startRun, coverageRequest: coverageRequest(body) }, eliciting)
      const opened = await raw('start_run', START, context()) as InputRequiredResult
      const answered = await raw('start_run', START, context(opened.requestState, {
        action: 'accept', content: { choice: 'Update coverage first' },
      }))
      const result = JSON.parse((answered.content as Array<{ text: string }>)[0].text)
      expect(result.nextSteps).toEqual(['follow the existing coverage owner', 'confirm coverage freshness', 'retry start_run'])
    }
    expect(startRun).not.toHaveBeenCalled()
  })

  it('tells the caller to follow a Flight even when its status is not currently reported', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const { raw } = harness({
      startRun,
      coverageRequest: coverageRequest(coverageChange('stale', 'coverage-flight-no-status', { flightId: 'flight-1' })),
    }, eliciting)
    const opened = await raw('start_run', START, context()) as InputRequiredResult
    const answered = await raw('start_run', START, context(opened.requestState, {
      action: 'accept', content: { choice: 'Update coverage first' },
    }))

    expect(JSON.stringify(answered)).toContain('Flight flight-1 owns this update')
    expect(startRun).not.toHaveBeenCalled()
  })

  it.each(['decline', 'cancel'])('starts nothing when the client answers %s on the stale-coverage question', async (action) => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const { raw } = harness({ startRun, coverageRequest: coverageRequest() }, eliciting)
    const opened = await raw('start_run', START, context()) as InputRequiredResult

    const answered = await raw('start_run', START, context(opened.requestState, { action }))

    // Reported as the CLIENT's answer: a client that declares elicitation and
    // wires no handler declines by itself, so naming the human here would invent
    // a decision about running against stale coverage that nobody made.
    const { reason } = JSON.parse((answered as { content: [{ text: string }] }).content[0].text)
    expect(reason).toContain(`The client answered "${action}"`)
    expect(reason).not.toMatch(/the user chose/i)
    expect(startRun).not.toHaveBeenCalled()
  })

  it('starts a diagnostic run only after the user accepts stale coverage, and qualifies the result', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const { raw } = harness({ startRun, coverageRequest: coverageRequest() }, eliciting)
    const opened = await raw('start_run', START, context()) as InputRequiredResult

    const answered = await raw('start_run', START, context(opened.requestState, {
      action: 'accept', content: { choice: 'Run now with stale coverage' },
    }))
    const result = JSON.parse((answered.content as Array<{ text: string }>)[0].text)

    expect(result).toMatchObject({
      runId: 'run-new', coverageStale: true, coverageRevision: 'coverage-v1',
      coverageMessage: expect.stringContaining('does not update'),
    })
    expect(startRun).toHaveBeenCalledOnce()
  })

  it('keeps coverage and repository isolation as two ordered user questions', async () => {
    const startRun = vi.fn(async (_f: string, _e: unknown, _r: unknown, isolation?: string) =>
      isolation ? { kind: 'started', runId: 'run-new' } : collision)
    const { raw } = harness({ startRun, coverageRequest: coverageRequest() }, eliciting)
    const coverageOpened = await raw('start_run', START, context()) as InputRequiredResult

    const isolationOpened = await raw('start_run', START, context(coverageOpened.requestState, {
      action: 'accept', content: { choice: 'Run now with stale coverage' },
    })) as InputRequiredResult
    expect(isolationOpened.requestState).not.toBe(coverageOpened.requestState)
    expect(isolationOpened.inputRequests).toMatchObject({ answer: { params: {
      requestedSchema: { properties: { isolation: { enum: ['worktree', 'queue'] } } },
    } } })

    const answered = await raw('start_run', START, context(isolationOpened.requestState, {
      action: 'accept', content: { isolation: 'worktree' },
    }))
    expect(JSON.parse((answered.content as Array<{ text: string }>)[0].text)).toMatchObject({
      runId: 'run-new', coverageStale: true,
    })
    expect(startRun).toHaveBeenCalledTimes(2)
    expect(startRun.mock.lastCall?.[3]).toBe('worktree')
  })

  it('rejects an approval when the coverage revision changes while the form is open', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const read = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, body: coverageChange('stale', 'coverage-v1') })
      .mockResolvedValue({ statusCode: 200, body: coverageChange('stale', 'coverage-v2') })
    const { raw } = harness({ startRun, coverageRequest: read }, eliciting)
    const opened = await raw('start_run', START, context()) as InputRequiredResult

    const answered = await raw('start_run', START, context(opened.requestState, {
      action: 'accept', content: { choice: 'Run now with stale coverage' },
    }))

    expect(JSON.stringify(answered)).toContain('work changed while the question was open')
    expect(startRun).not.toHaveBeenCalled()
  })

  it('rejects a stale-coverage answer when the current check no longer requires a choice', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const read = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, body: coverageChange('stale', 'coverage-v1') })
      .mockResolvedValueOnce({ statusCode: 200, body: coverageChange('current', 'coverage-v1') })
    const { raw } = harness({ startRun, coverageRequest: read }, eliciting)
    const opened = await raw('start_run', START, context()) as InputRequiredResult

    const answered = await raw('start_run', START, context(opened.requestState, {
      action: 'accept', content: { choice: 'Run now with stale coverage' },
    }))
    expect(JSON.stringify(answered)).toContain('Coverage changed while the question was open')
    expect(startRun).not.toHaveBeenCalled()
  })

  it('rejects repository isolation when coverage changes after run-now approval', async () => {
    const startRun = vi.fn(async (_f: string, _e: unknown, _r: unknown, isolation?: string) =>
      isolation ? { kind: 'started', runId: 'run-new' } : collision)
    const read = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, body: coverageChange('stale', 'coverage-v1') })
      .mockResolvedValueOnce({ statusCode: 200, body: coverageChange('stale', 'coverage-v1') })
      .mockResolvedValueOnce({ statusCode: 200, body: coverageChange('stale', 'coverage-v1') })
      .mockResolvedValue({ statusCode: 200, body: coverageChange('stale', 'coverage-v2') })
    const { raw } = harness({ startRun, coverageRequest: read }, eliciting)
    const coverageOpened = await raw('start_run', START, context()) as InputRequiredResult
    const isolationOpened = await raw('start_run', START, context(coverageOpened.requestState, {
      action: 'accept', content: { choice: 'Run now with stale coverage' },
    })) as InputRequiredResult

    const answered = await raw('start_run', START, context(isolationOpened.requestState, {
      action: 'accept', content: { isolation: 'worktree' },
    }))

    expect(JSON.stringify(answered)).toContain('work changed while the question was open')
    expect(startRun).toHaveBeenCalledOnce()
    expect(startRun.mock.calls[0]?.[3]).toBeUndefined()
  })

  it('does not route a stale-coverage isolation answer once coverage evidence is unavailable', async () => {
    const startRun = vi.fn(async () => collision)
    const read = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, body: coverageChange('stale', 'coverage-v1') })
      .mockResolvedValueOnce({ statusCode: 200, body: coverageChange('stale', 'coverage-v1') })
      .mockResolvedValueOnce({ statusCode: 200, body: coverageChange('stale', 'coverage-v1') })
      .mockResolvedValue({ statusCode: 503, body: {} })
    const { raw } = harness({ startRun, coverageRequest: read }, eliciting)
    const coverageOpened = await raw('start_run', START, context()) as InputRequiredResult
    const isolationOpened = await raw('start_run', START, context(coverageOpened.requestState, {
      action: 'accept', content: { choice: 'Run now with stale coverage' },
    })) as InputRequiredResult

    const answered = await raw('start_run', START, context(isolationOpened.requestState, {
      action: 'accept', content: { isolation: 'worktree' },
    }))

    expect(JSON.stringify(answered)).toContain('belongs to a different operation')
    expect(startRun).toHaveBeenCalledOnce()
  })

  it('starts normally when coverage is current but still needs a proving run', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const { call } = harness({ startRun, coverageRequest: coverageRequest(coverageChange('current')) })

    expect(await call('start_run', START)).toMatchObject({ runId: 'run-new' })
    expect(startRun).toHaveBeenCalledOnce()
  })

  it('forwards the session, the claimability and the isolation choice', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const { call } = harness({ startRun })

    const out = await call('start_run', {
      ...START, env: 'local', conversation_name: 'fix checkout', isolation: 'worktree',
    })

    expect(startRun).toHaveBeenCalledWith(
      'checkout',
      'local',
      { kind: 'external', sessionId: 'sess-1', clientKind: 'claude', conversationName: 'fix checkout', claimable: true },
      'worktree',
      undefined,
      undefined,
      undefined,
    )
    expect(out).toEqual({ runId: 'run-new', reused: false, claimed: true, nextSteps: ['wait_for_heal_task'] })
  })

  it('forwards a robustness envelope untouched, so the route is the one validator of it', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const { call } = harness({ startRun })
    const perturbation = { format: 'canary-lab/robustness-envelope@1', latency: { ms: 262 } }

    const out = await call('start_run', { ...START, perturbation })

    expect(startRun.mock.calls[0]?.[5]).toEqual(perturbation)
    expect(out).toEqual({ runId: 'run-new', reused: false, claimed: true, nextSteps: ['wait_for_heal_task'] })
  })

  it('starts a blocked client\'s run unclaimed, so it waits for a Desktop/UI drive', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const { call } = harness({ startRun })

    const out = await call('start_run', { ...START, client_kind: 'claude-pty' })

    // The run still starts in external mode; what it must not do is tell a PTY
    // agent to go wait on a heal task it is not allowed to own.
    expect(startRun).toHaveBeenCalledWith(
      'checkout',
      undefined,
      { kind: 'external', sessionId: 'sess-1', clientKind: 'claude-pty', claimable: false },
      undefined,
      undefined,
      undefined,
      undefined,
    )
    expect(out).toEqual({
      runId: 'run-new',
      reused: false,
      claimed: false,
      claimSuppressed: true,
      message: CLAIM_SUPPRESSED_MESSAGE,
    })
  })

  it('forwards the update_repos choice as the seventh factory argument', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'run-new' }))
    const { call } = harness({ startRun })

    await call('start_run', { ...START, update_repos: false })

    expect(startRun.mock.calls[0]?.[6]).toBe(false)
  })

  it('relays a refused upstream update with the per-repo rows, having started nothing', async () => {
    const repos = [{ name: 'app', path: '/repo/shop', branch: 'main', reason: 'diverged', message: 'main has 1 local commit(s)' }]
    const { call } = harness({
      startRun: async () => ({ kind: 'repo-update-refused', repos, message: 'Repo upstream update refused:\napp: main has 1 local commit(s)' }),
    })

    const out = await call('start_run', START)

    expect(out).toMatchObject({ type: 'repo_update_refused', feature: 'checkout', repos })
    expect(String(out.nextSteps)).toContain('update_repos:false')
    expect(out).not.toHaveProperty('runId')
  })

  it('stands down when a Getting Started demo owns the workspace', async () => {
    const active = { sessionId: 'demo-1', workflow: 'flight', owner: 'internal', target: { kind: 'flight', id: 'f1' } }
    const { call } = harness({
      startRun: async () => ({ kind: 'getting-started-busy', active, message: 'a demo is running' }),
    })

    expect(await call('start_run', START)).toEqual({
      type: 'getting_started_busy',
      active,
      message: 'a demo is running',
      nextSteps: ['follow the active demo in its current owner; do not start another run or flight'],
    })
  })

  it('asks the user to pick isolation on a same-repo collision, having started nothing', async () => {
    const collision = {
      kind: 'collision',
      conflictingRunId: 'run-9',
      conflictingFeature: 'search',
      repoPaths: ['/repo/shop'],
      options: ['worktree', 'queue'],
      message: 'run-9 is using /repo/shop',
    }
    const { call } = harness({ startRun: async () => collision })

    const { kind: _kind, ...expected } = collision
    expect(await call('start_run', START)).toEqual({
      type: 'repo_collision_requires_choice',
      ...expected,
      nextSteps: ['ask_user_worktree_or_queue'],
    })
  })

  it('reports a parked run as queued, with the reason it is waiting', async () => {
    const { call } = harness({
      startRun: async () => ({ kind: 'queued', runId: 'run-new', reason: 'resources' }),
    })

    expect(await call('start_run', START)).toEqual({
      runId: 'run-new',
      reused: false,
      queued: true,
      queueReason: 'resources',
      claimed: true,
      nextSteps: ['wait_for_heal_task'],
    })
  })

  it('reports a queued run with no claim for a blocked client', async () => {
    const { call } = harness({
      startRun: async () => ({ kind: 'queued', runId: 'run-new', reason: 'repo-collision' }),
    })

    expect(await call('start_run', { ...START, client_kind: 'codex-pty' })).toMatchObject({
      queued: true,
      queueReason: 'repo-collision',
      claimed: false,
      claimSuppressed: true,
    })
  })

  it('surfaces a rejected start instead of letting it escape as a tool crash', async () => {
    const { text } = harness({
      startRun: async () => { throw new Error('no envset named local') },
    })

    expect(await text('start_run', START)).toBe('no envset named local')
  })
})

describe('boot_services', () => {
  it('starts a boot-only run and points at abort_run for teardown', async () => {
    const startRun = vi.fn(async () => ({ kind: 'started', runId: 'boot-1' }))
    const { call } = harness({ startRun })

    const out = await call('boot_services', { feature: 'checkout', env: 'local', isolation: 'worktree' })

    // No heal agent: a boot session has no loop to own, so the third argument
    // is deliberately undefined and the execution type is what marks it.
    expect(startRun).toHaveBeenCalledWith('checkout', 'local', undefined, 'worktree', 'boot')
    expect(out).toMatchObject({ runId: 'boot-1', booted: true })
    expect(String(out.nextSteps)).toContain('abort_run')
  })

  it('stands down when a Getting Started demo owns the workspace', async () => {
    const active = { sessionId: 'demo-1', workflow: 'run', owner: 'external', target: null }
    const { call } = harness({
      startRun: async () => ({ kind: 'getting-started-busy', active, message: 'a demo is running' }),
    })

    expect(await call('boot_services', { feature: 'checkout' })).toMatchObject({
      type: 'getting_started_busy',
      active,
    })
  })

  it('asks the user to pick isolation on a same-repo collision', async () => {
    const { call } = harness({
      startRun: async () => ({
        kind: 'collision',
        conflictingRunId: 'run-9',
        conflictingFeature: 'search',
        repoPaths: ['/repo/shop'],
        options: ['queue'],
        message: 'run-9 is using /repo/shop',
      }),
    })

    expect(await call('boot_services', { feature: 'checkout' })).toMatchObject({
      type: 'repo_collision_requires_choice',
      conflictingRunId: 'run-9',
      options: ['queue'],
      nextSteps: ['ask_user_worktree_or_queue'],
    })
  })

  it('relays a refused upstream update for a tracked repo, having booted nothing', async () => {
    const repos = [{ name: 'app', path: '/repo/shop', branch: 'main', reason: 'dirty', message: 'uncommitted changes' }]
    const { call } = harness({
      startRun: async () => ({ kind: 'repo-update-refused', repos, message: 'Repo upstream update refused' }),
    })

    const out = await call('boot_services', { feature: 'checkout' })

    expect(out).toMatchObject({ type: 'repo_update_refused', feature: 'checkout', repos, message: 'Repo upstream update refused' })
    expect(String(out.nextSteps)).toContain('re-call boot_services')
    expect(out).not.toHaveProperty('booted')
  })

  it('reports a parked boot as queued', async () => {
    const { call } = harness({
      startRun: async () => ({ kind: 'queued', runId: 'boot-1', reason: 'resources' }),
    })

    const out = await call('boot_services', { feature: 'checkout' })

    expect(out).toMatchObject({ runId: 'boot-1', queued: true, queueReason: 'resources' })
    expect(out).not.toHaveProperty('booted')
  })

  it('surfaces a rejected boot instead of letting it escape as a tool crash', async () => {
    const { text } = harness({
      startRun: async () => { throw new Error('feature not found: ghost') },
    })

    expect(await text('boot_services', { feature: 'ghost' })).toBe('feature not found: ghost')
  })
})

describe('pause_run', () => {
  it('reports a run that holds no live orchestrator', async () => {
    const { text } = harness()

    expect(await text('pause_run', { runId: 'run-1' })).toBe('run not active: run-1')
  })

  it('relays the orchestrator\'s refusal verbatim', async () => {
    const orch = { pauseAndHeal: async () => ({ ok: false, reason: 'tests already finished' }) }
    const { text } = harness({ store: storeOf([], { registry: { get: () => orch } }) })

    expect(await text('pause_run', { runId: 'run-1' })).toBe('could not pause: tests already finished')
  })

  it('pauses into heal and carries the failure count across', async () => {
    const orch = { pauseAndHeal: async () => ({ ok: true, failureCount: 2 }) }
    const { call } = harness({ store: storeOf([], { registry: { get: () => orch } }) })

    expect(await call('pause_run', { runId: 'run-1' })).toEqual({ status: 'healing', failureCount: 2 })
  })
})

describe('cancel_heal', () => {
  it('reports a run that holds no live orchestrator', async () => {
    const { text } = harness()

    expect(await text('cancel_heal', { runId: 'run-1' })).toBe('run not active: run-1')
  })

  it('relays the orchestrator\'s refusal verbatim', async () => {
    const orch = { cancelHeal: async () => ({ ok: false, reason: 'no heal cycle in flight' }) }
    const { text } = harness({ store: storeOf([], { registry: { get: () => orch } }) })

    expect(await text('cancel_heal', { runId: 'run-1' })).toBe('could not cancel: no heal cycle in flight')
  })

  it('cancels the in-flight cycle', async () => {
    const orch = { cancelHeal: async () => ({ ok: true }) }
    const { call } = harness({ store: storeOf([], { registry: { get: () => orch } }) })

    expect(await call('cancel_heal', { runId: 'run-1' })).toEqual({ status: 'cancelled' })
  })
})

describe('abort_run', () => {
  it('is marked destructive so a client can gate the call before making it', () => {
    const { configs } = harness()

    // Not idempotent: a second abort has nothing left to kill, so a client that
    // retries on the hint alone would be told the run is still abortable.
    expect(configs.get('abort_run')!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false })
  })

  it('rejects unknown and terminal runs before asking the human to stop anything', async () => {
    const missing = harness({ store: storeOf([]) })
    expect(await missing.text('abort_run', { runId: 'missing', confirm: true })).toBe('run not found: missing')

    const terminal = harness({ store: storeOf([runDetail({ status: 'passed' })]) })
    expect(await terminal.text('abort_run', { runId: 'run-1', confirm: true })).toBe('run not active: run-1')
  })

  it('relays the store\'s refusal verbatim', async () => {
    const { raw } = harness({ store: storeOf([runDetail()], { abort: async () => ({ ok: false, reason: 'already terminal' }) }) }, eliciting)
    const args = { runId: 'run-1', confirm: true }
    const question = await raw('abort_run', args, context()) as InputRequiredResult
    const result = await raw('abort_run', args, context(question.requestState, { action: 'accept', content: { action: 'abort' } }))
    expect(result.content).toEqual([{ type: 'text', text: 'could not abort: already terminal' }])
  })

  it('stops only after a human answer, and applies transport retries once', async () => {
    const abort = vi.fn(async () => ({ ok: true }))
    const { raw } = harness({ store: storeOf([runDetail()], { abort }) }, eliciting)
    const args = { runId: 'run-1', confirm: true }
    const question = await raw('abort_run', args, context()) as InputRequiredResult
    expect(question.resultType).toBe('input_required')
    expect(abort).not.toHaveBeenCalled()
    const accepted = context(question.requestState, { action: 'accept', content: { action: 'abort' } })
    const result = await raw('abort_run', args, accepted)
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ aborted: true, runId: 'run-1' })
    expect(await raw('abort_run', args, accepted)).toEqual(result)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledWith('run-1')
  })

  it('never treats confirm:true as authority when the client cannot show a form', async () => {
    const abort = vi.fn()
    const { call } = harness({ store: storeOf([runDetail()], { abort }) })
    expect(await call('abort_run', { runId: 'run-1', confirm: true })).toMatchObject({ type: 'abort_requires_confirmation' })
    expect(abort).not.toHaveBeenCalled()
  })

  it.each(['decline', 'cancel', 'keep', 'forged', 'stale'])('does not stop a run after %s input', async (choice) => {
    const detail = runDetail()
    const abort = vi.fn()
    const { raw } = harness({ store: storeOf([detail], { abort }) }, eliciting)
    const args = { runId: 'run-1', confirm: true }
    const question = await raw('abort_run', args, context()) as InputRequiredResult
    if (choice === 'stale') detail.manifest.healCycles = 2
    await raw('abort_run', args, context(choice === 'forged' ? 'forged-handle' : question.requestState, {
      action: choice === 'decline' || choice === 'cancel' ? choice : 'accept',
      content: { action: choice === 'keep' ? 'keep' : 'abort' },
    }))
    expect(abort).not.toHaveBeenCalled()
  })
})
