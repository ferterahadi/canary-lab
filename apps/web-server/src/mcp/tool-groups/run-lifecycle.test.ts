import { describe, expect, it, vi } from 'vitest'
import type { RunDetail } from '../../features/runs/logic/run-store'
import { CLAIM_SUPPRESSED_MESSAGE } from '../tool-support'
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

function harness(over: Record<string, unknown> = {}) {
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
  })
  return { ...tools, claims }
}

describe('start_run: continuing the run that is already healing', () => {
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

  it('starts a fresh concurrent run beside the healing one on force_new', async () => {
    const { call } = harness({ store: storeOf([runDetail({ status: 'healing' })]) })

    expect(await call('start_run', { ...START, force_new: true }))
      .toEqual({ runId: 'run-new', reused: false, claimed: true, nextSteps: ['wait_for_heal_task'] })
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
    )
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
    )
    expect(out).toEqual({
      runId: 'run-new',
      reused: false,
      claimed: false,
      claimSuppressed: true,
      message: CLAIM_SUPPRESSED_MESSAGE,
    })
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
  it('relays the store\'s refusal verbatim', async () => {
    const { text } = harness({ store: storeOf([], { abort: async () => ({ ok: false, reason: 'already terminal' }) }) })

    expect(await text('abort_run', { runId: 'run-1', confirm: true })).toBe('could not abort: already terminal')
  })

  it('aborts the run and echoes which one', async () => {
    const abort = vi.fn(async () => ({ ok: true }))
    const { call } = harness({ store: storeOf([], { abort }) })

    expect(await call('abort_run', { runId: 'run-1', confirm: true })).toEqual({ aborted: true, runId: 'run-1' })
    expect(abort).toHaveBeenCalledWith('run-1')
  })
})
