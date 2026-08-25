import { describe, expect, it, vi } from 'vitest'
import type { RunDetail, RunIndexEntry } from '../features/runs/logic/run-store'
import type { CanaryLabMcpDeps } from './tool-schemas'
import {
  activeRunPriority,
  claimRun,
  ensureExternalClaimForMcpCall,
  findHealingRunForFeature,
  mcpVerificationStatus,
  resolveRunRef,
  runCandidate,
  verificationResult,
} from './tool-support'

// The run-selection and heal-claim layer behind start_run / get_verification_result:
// which run an external client is handed, whether it owns that run's heal loop, and
// how a verification execution is reported. Every value here lands directly in a
// tool result the agent acts on, so the assertions are about what the agent is
// TOLD — a rejected claim must never read as claimed, and an index row whose run
// artifacts are gone must never be handed out as a healing run to drive.
//
// server.smoke.run-ref.test.ts proves the same selections end to end over a real
// MCP client. This suite drives the states a live server only reaches by racing:
// the index disagreeing with the manifest, two runs healing at once, and a foreign
// session touching a claim it does not own.

function runDetail(manifest: Record<string, unknown> = {}): RunDetail {
  return {
    runId: (manifest.runId as string | undefined) ?? 'run-1',
    manifest: {
      runId: 'run-1', feature: 'checkout', env: 'local',
      startedAt: '2026-05-25T08:00:00.000Z', status: 'healing',
      healCycles: 1, services: [],
      ...manifest,
    },
    summary: {
      complete: false, total: 1, passed: 0,
      failed: [{ name: 'checkout fails', error: { message: 'boom' }, location: 'e2e/checkout.spec.ts:1:1' }],
    },
  } as unknown as RunDetail
}

function indexRow(over: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    runId: 'run-1', feature: 'checkout',
    startedAt: '2026-05-25T08:00:00.000Z', status: 'healing',
    ...over,
  } as RunIndexEntry
}

/** A store fake whose index rows and run details are supplied separately, because
 *  in the real store they are separate files: the runs index is a cache and the
 *  manifest is truth, so a row whose detail no longer resolves (a cleaned-away run
 *  directory) is a state these helpers have to survive rather than a fixture quirk. */
function fakeStore(rows: RunIndexEntry[], details: RunDetail[]) {
  const byId = new Map(details.map((d) => [d.manifest.runId, d]))
  return {
    list: ({ feature }: { feature?: string } = {}) =>
      rows.filter((row) => feature === undefined || row.feature === feature),
    get: (runId: string) => byId.get(runId) ?? null,
  }
}

function fakeBroker(over: Record<string, unknown> = {}) {
  return {
    getSession: vi.fn(() => null as unknown),
    claim: vi.fn(() => ({ accepted: true, session: { sessionId: 'sess-1', clientKind: 'claude' } }) as unknown),
    touch: vi.fn(() => ({ ok: true })),
    ...over,
  }
}

function asDeps(deps: Record<string, unknown>): CanaryLabMcpDeps {
  return deps as unknown as CanaryLabMcpDeps
}

describe('claimRun', () => {
  it('forwards the conversation name so the owning chat is on the record', () => {
    const broker = fakeBroker()

    const result = claimRun(asDeps({ broker }), 'run-1', 'sess-1', 'claude', 'Checkout repair')

    expect(result).toEqual({ accepted: true, session: { sessionId: 'sess-1', clientKind: 'claude' } })
    expect(broker.claim).toHaveBeenCalledWith('run-1', {
      sessionId: 'sess-1',
      clientKind: 'claude',
      conversationName: 'Checkout repair',
    })
  })

  it('omits the conversation name key entirely when the client sent none', () => {
    const broker = fakeBroker()

    claimRun(asDeps({ broker }), 'run-1', 'sess-1', 'codex', undefined)

    // Not `conversationName: undefined`: the claim input is persisted onto the
    // session record, so passing the key through would blank a name a previous
    // reclaim from the same session had already stored.
    expect(Object.keys((broker.claim.mock.calls as unknown as unknown[][])[0][1] as object)).toEqual(['sessionId', 'clientKind'])
  })

  it('reports who already owns the run when the claim is refused', () => {
    const currentSession = { sessionId: 'other-sess', clientKind: 'codex' }
    const broker = fakeBroker({
      claim: vi.fn(() => ({ accepted: false, reason: 'already-claimed', currentSession })),
    })

    expect(claimRun(asDeps({ broker }), 'run-1', 'sess-1', 'claude', undefined)).toEqual({
      accepted: false,
      reason: 'already-claimed',
      currentSession,
    })
  })

  it('refuses a disallowed client kind without inventing a current session', () => {
    // start_run renders `claimed: claim?.accepted === true`, so the only thing
    // that must not happen here is an accepted-looking result. `currentSession`
    // stays absent because there is no owner to name — the claim never happened.
    const broker = fakeBroker({
      claim: vi.fn(() => ({ accepted: false, reason: 'client-kind-not-allowed', clientKind: 'other' })),
    })

    const result = claimRun(asDeps({ broker }), 'run-1', 'sess-1', 'other', 'CLI session')

    expect(result).toEqual({ accepted: false, reason: 'client-kind-not-allowed' })
    expect('currentSession' in result).toBe(false)
  })
})

describe('activeRunPriority', () => {
  it('ranks a run parked for a fix ahead of one still healing, and both ahead of the rest', () => {
    // This ordering is why start_run continues the run that is actually waiting
    // for the client's edit instead of one mid-cycle that cannot accept a signal.
    expect(activeRunPriority(runDetail({ lifecycle: { phase: 'waiting-for-signal', activeCycle: 1 } }))).toBe(0)
    expect(activeRunPriority(runDetail({ status: 'healing' }))).toBe(1)
    expect(activeRunPriority(runDetail({ status: 'running', lifecycle: { phase: 'running-tests' } }))).toBe(2)
  })
})

describe('findHealingRunForFeature', () => {
  it('hands back the healing run for the feature', () => {
    const detail = runDetail()
    const store = fakeStore([indexRow()], [detail])

    expect(findHealingRunForFeature(asDeps({ store }), 'checkout', undefined)).toBe(detail)
  })

  it('ignores index rows that are not healing', () => {
    const passed = runDetail({ runId: 'run-passed', status: 'passed' })
    const store = fakeStore([indexRow({ runId: 'run-passed', status: 'passed' })], [passed])

    expect(findHealingRunForFeature(asDeps({ store }), 'checkout', undefined)).toBeNull()
  })

  it('ignores a healing row whose run artifacts are gone', () => {
    // Log Cleanup can remove a run directory while its index row is still there.
    // Returning the row would hand the client a runId with no manifest to heal.
    const store = fakeStore([indexRow({ runId: 'run-swept' })], [])

    expect(findHealingRunForFeature(asDeps({ store }), 'checkout', undefined)).toBeNull()
  })

  it('keeps only the requested env when one is named, and every env when none is', () => {
    const local = runDetail({ runId: 'run-local', env: 'local' })
    const staging = runDetail({ runId: 'run-staging', env: 'staging' })
    const rows = [indexRow({ runId: 'run-local' }), indexRow({ runId: 'run-staging' })]
    const deps = asDeps({ store: fakeStore(rows, [local, staging]) })

    expect(findHealingRunForFeature(deps, 'checkout', 'staging')).toBe(staging)
    expect(findHealingRunForFeature(deps, 'checkout', undefined)).toBe(local)
  })

  it('prefers the run parked for a fix over a newer one still mid-cycle', () => {
    const parked = runDetail({
      runId: 'run-parked', startedAt: '2026-05-25T08:00:00.000Z',
      lifecycle: { phase: 'waiting-for-signal', activeCycle: 2 },
    })
    const midCycle = runDetail({
      runId: 'run-mid', startedAt: '2026-05-25T09:00:00.000Z',
      lifecycle: { phase: 'agent-healing', activeCycle: 1 },
    })
    const rows = [indexRow({ runId: 'run-mid' }), indexRow({ runId: 'run-parked' })]

    // Newest-first would pick run-mid; priority beats recency because only the
    // parked run can accept the signal the client is about to send.
    expect(findHealingRunForFeature(asDeps({ store: fakeStore(rows, [midCycle, parked]) }), 'checkout', undefined))
      .toBe(parked)
  })

  it('picks the newest of two equally-parked runs whichever order the index lists them', () => {
    const STARTED = {
      'run-older': '2026-05-25T08:00:00.000Z',
      'run-newer': '2026-05-25T09:00:00.000Z',
    } as const
    const older = runDetail({ runId: 'run-older', startedAt: STARTED['run-older'] })
    const newer = runDetail({ runId: 'run-newer', startedAt: STARTED['run-newer'] })
    // The recency tiebreak reads the INDEX row's startedAt, not the manifest's —
    // the index is the list being sorted. Varying only the manifest leaves both
    // rows on the default timestamp, which makes the sort a no-op and the test
    // pass or fail on input order instead of on recency.
    const rows = (ids: Array<keyof typeof STARTED>) =>
      ids.map((runId) => indexRow({ runId, startedAt: STARTED[runId] }))

    // The real index arrives newest-first; the helper re-sorts rather than
    // trusting that, so both input orders have to land on the same run.
    expect(findHealingRunForFeature(
      asDeps({ store: fakeStore(rows(['run-older', 'run-newer']), [older, newer]) }), 'checkout', undefined,
    )).toBe(newer)
    expect(findHealingRunForFeature(
      asDeps({ store: fakeStore(rows(['run-newer', 'run-older']), [older, newer]) }), 'checkout', undefined,
    )).toBe(newer)
  })

  it('never hands back another feature\'s healing run', () => {
    const mine = runDetail({ runId: 'run-mine', feature: 'checkout' })
    const theirs = runDetail({ runId: 'run-theirs', feature: 'search' })
    const rows = [
      // Listed FIRST and started LATER, so both the index order and the recency
      // tiebreak would pick it if the feature filter were dropped.
      indexRow({ runId: 'run-theirs', feature: 'search', startedAt: '2026-05-25T09:00:00.000Z' }),
      indexRow({ runId: 'run-mine', feature: 'checkout', startedAt: '2026-05-25T08:00:00.000Z' }),
    ]

    const found = findHealingRunForFeature(asDeps({ store: fakeStore(rows, [mine, theirs]) }), 'checkout', undefined)

    // start_run("checkout") continuing search's heal loop would drive an agent
    // at the wrong repos entirely.
    expect(found).toBe(mine)
  })

  it('keeps the index order when two runs started in the same millisecond', () => {
    const first = runDetail({ runId: 'run-a' })
    const second = runDetail({ runId: 'run-b' })
    const rows = [indexRow({ runId: 'run-a' }), indexRow({ runId: 'run-b' })]

    expect(findHealingRunForFeature(asDeps({ store: fakeStore(rows, [first, second]) }), 'checkout', undefined))
      .toBe(first)
  })
})

describe('resolveRunRef', () => {
  const detail = runDetail({ runId: 'run-2026-05-25-7cvh' })
  const rows = [indexRow({ runId: 'run-2026-05-25-7cvh' })]

  it('resolves a full run id', () => {
    const resolved = resolveRunRef(asDeps({ store: fakeStore(rows, [detail]) }), 'checkout', undefined, 'run-2026-05-25-7cvh')

    expect(resolved).toEqual({ kind: 'resolved', detail })
  })

  it('resolves the short suffix an agent is told to pass ("rerun 7cvh")', () => {
    const resolved = resolveRunRef(asDeps({ store: fakeStore(rows, [detail]) }), 'checkout', undefined, '7cvh')

    expect(resolved).toEqual({ kind: 'resolved', detail })
  })

  it('reports a ref that matches nothing as missing', () => {
    const resolved = resolveRunRef(asDeps({ store: fakeStore(rows, [detail]) }), 'checkout', undefined, 'zzzz')

    expect(resolved).toEqual({ kind: 'missing' })
  })

  it('skips a row whose run artifacts are gone', () => {
    const store = fakeStore([...rows, indexRow({ runId: 'run-2026-05-24-7cvh' })], [detail])

    expect(resolveRunRef(asDeps({ store }), 'checkout', undefined, '7cvh')).toEqual({ kind: 'resolved', detail })
  })

  it('never resolves a ref against another feature\'s run', () => {
    // Same 4-char suffix in a different feature. Without the feature filter this
    // is either the WRONG run or a bogus `ambiguous`, and "rerun 7cvh" would act
    // on a foreign repo set.
    const foreign = runDetail({ runId: 'run-2026-05-24-7cvh', feature: 'search' })
    const store = fakeStore(
      [...rows, indexRow({ runId: 'run-2026-05-24-7cvh', feature: 'search' })],
      [detail, foreign],
    )

    expect(resolveRunRef(asDeps({ store }), 'checkout', undefined, '7cvh')).toEqual({ kind: 'resolved', detail })
  })

  it('excludes runs from other envs when an env is named', () => {
    const staging = runDetail({ runId: 'run-2026-05-24-7cvh', env: 'staging' })
    const store = fakeStore([...rows, indexRow({ runId: 'run-2026-05-24-7cvh' })], [detail, staging])

    expect(resolveRunRef(asDeps({ store }), 'checkout', 'local', '7cvh')).toEqual({ kind: 'resolved', detail })
  })

  it('returns every candidate when a short ref matches more than one run', () => {
    // The tool renders these as an `ambiguous_run_ref` choice rather than guessing
    // — picking one would restart a run the user did not name.
    const older = runDetail({ runId: 'run-2026-05-24-7cvh' })
    const store = fakeStore([...rows, indexRow({ runId: 'run-2026-05-24-7cvh' })], [detail, older])

    expect(resolveRunRef(asDeps({ store }), 'checkout', undefined, '7cvh')).toEqual({
      kind: 'ambiguous',
      candidates: [detail, older],
    })
  })
})

describe('runCandidate', () => {
  it('describes a finished run by its own recorded facts', () => {
    const detail = runDetail({
      runId: 'run-7cvh', executionType: 'boot', env: 'staging',
      status: 'failed', endedAt: '2026-05-25T08:12:00.000Z',
    })

    expect(runCandidate(detail)).toEqual({
      runId: 'run-7cvh',
      executionType: 'boot',
      feature: 'checkout',
      env: 'staging',
      status: 'failed',
      startedAt: '2026-05-25T08:00:00.000Z',
      endedAt: '2026-05-25T08:12:00.000Z',
    })
  })

  it('fills the fields a still-running plain run has not recorded yet', () => {
    // `executionType` predates the boot/verify split, so an older manifest has
    // none; env and endedAt read as explicit nulls rather than dropping out of
    // the row the agent compares candidates in.
    expect(runCandidate(runDetail({ env: undefined }))).toEqual({
      runId: 'run-1',
      executionType: 'run',
      feature: 'checkout',
      env: null,
      status: 'healing',
      startedAt: '2026-05-25T08:00:00.000Z',
      endedAt: null,
    })
  })
})

describe('mcpVerificationStatus', () => {
  it('renames only aborted, so a failed verification still reads as failed', () => {
    expect(mcpVerificationStatus('aborted')).toBe('cancelled')
    expect(mcpVerificationStatus('failed')).toBe('failed')
    expect(mcpVerificationStatus('passed')).toBe('passed')
    expect(mcpVerificationStatus('running')).toBe('running')
  })
})

describe('verificationResult', () => {
  it('reports the recorded verification metadata, diagnostics included', () => {
    const detail = runDetail({
      runId: 'verify-1', executionType: 'verify', status: 'failed',
      verification: {
        configId: 'cfg-1',
        configName: 'staging smoke',
        playwrightEnvsetId: 'staging',
        targetUrls: { web: 'https://staging.example.com' },
        targets: [],
        diagnostics: {
          generatedAt: '2026-05-25T08:10:00.000Z',
          summary: '1 of 3 checks failed',
          targetUrls: { web: 'https://staging.example.com' },
          failedTests: [],
        },
      },
    })

    expect(verificationResult(detail)).toEqual({
      executionId: 'verify-1',
      executionType: 'verify',
      status: 'failed',
      configName: 'staging smoke',
      targetUrls: { web: 'https://staging.example.com' },
      playwrightEnvsetId: 'staging',
      diagnostics: {
        generatedAt: '2026-05-25T08:10:00.000Z',
        summary: '1 of 3 checks failed',
        targetUrls: { web: 'https://staging.example.com' },
        failedTests: [],
      },
    })
  })

  it('omits configName and diagnostics for an ad-hoc verification that has neither', () => {
    // A verification started from target URLs alone has no saved config, and one
    // that never got past boot has no diagnostics. Both keys stay absent rather
    // than reading as an empty config or an empty diagnostic report.
    const detail = runDetail({
      runId: 'verify-2', executionType: 'verify', status: 'running',
      verification: { playwrightEnvsetId: 'staging', targetUrls: {}, targets: [] },
    })

    expect(verificationResult(detail)).toEqual({
      executionId: 'verify-2',
      executionType: 'verify',
      status: 'running',
      targetUrls: {},
      playwrightEnvsetId: 'staging',
    })
  })

  it('falls back to the run env when the execution has no verification metadata yet', () => {
    const detail = runDetail({ runId: 'verify-3', executionType: 'verify', status: 'aborted', env: 'staging' })

    expect(verificationResult(detail)).toEqual({
      executionId: 'verify-3',
      executionType: 'verify',
      status: 'cancelled',
      targetUrls: {},
      playwrightEnvsetId: 'staging',
    })
  })

  it('reports an empty envset rather than null when neither metadata nor env exists', () => {
    const detail = runDetail({ runId: 'verify-4', executionType: 'verify', status: 'queued', env: undefined })

    expect(verificationResult(detail)).toMatchObject({
      executionId: 'verify-4',
      status: 'queued',
      playwrightEnvsetId: '',
    })
  })
})

describe('ensureExternalClaimForMcpCall', () => {
  /** A run parked in external heal — the only shape that gets an implicit claim. */
  function externalDeps(over: Record<string, unknown> = {}, manifest: Record<string, unknown> = {}) {
    const broker = fakeBroker(over)
    const detail = runDetail({ healMode: 'external', ...manifest })
    return { broker, deps: asDeps({ broker, store: fakeStore([indexRow()], [detail]) }) }
  }

  it('claims an unclaimed external run for the calling session', () => {
    const { broker, deps } = externalDeps()

    ensureExternalClaimForMcpCall(deps, 'run-1', 'sess-1', 'claude')

    expect(broker.claim).toHaveBeenCalledWith('run-1', { sessionId: 'sess-1', clientKind: 'claude' })
  })

  it('heartbeats instead of re-claiming when the caller already owns the run', () => {
    const { broker, deps } = externalDeps({
      getSession: vi.fn(() => ({ sessionId: 'sess-1', clientKind: 'claude' })),
    })

    ensureExternalClaimForMcpCall(deps, 'run-1', 'sess-1', 'claude')

    expect(broker.touch).toHaveBeenCalledWith('run-1', 'sess-1')
    expect(broker.claim).not.toHaveBeenCalled()
  })

  it('upgrades an undetected claim once the client kind is known', () => {
    // The bridge detects the client on the connection, which can land after the
    // first tool call claimed as 'other'. Re-claiming from the SAME session
    // corrects the record; it is not a takeover.
    const { broker, deps } = externalDeps({
      getSession: vi.fn(() => ({ sessionId: 'sess-1', clientKind: 'other' })),
    })

    ensureExternalClaimForMcpCall(deps, 'run-1', 'sess-1', 'codex')

    expect(broker.claim).toHaveBeenCalledWith('run-1', { sessionId: 'sess-1', clientKind: 'codex' })
    expect(broker.touch).not.toHaveBeenCalled()
  })

  it('just heartbeats when the caller is still undetected', () => {
    const { broker, deps } = externalDeps({
      getSession: vi.fn(() => ({ sessionId: 'sess-1', clientKind: 'other' })),
    })

    ensureExternalClaimForMcpCall(deps, 'run-1', 'sess-1', 'other')

    expect(broker.claim).not.toHaveBeenCalled()
    expect(broker.touch).toHaveBeenCalledWith('run-1', 'sess-1')
  })

  it('leaves a claim owned by another session untouched', () => {
    // No force-takeover: a second client reading a run it does not own must not
    // silently become its heal agent, or two agents edit the same repo.
    const { broker, deps } = externalDeps({
      getSession: vi.fn(() => ({ sessionId: 'other-sess', clientKind: 'claude' })),
    })

    ensureExternalClaimForMcpCall(deps, 'run-1', 'sess-1', 'claude')

    expect(broker.claim).not.toHaveBeenCalled()
    expect(broker.touch).not.toHaveBeenCalled()
  })

  it('does nothing for a run that is not in external heal mode', () => {
    const broker = fakeBroker()
    const deps = asDeps({ broker, store: fakeStore([indexRow()], [runDetail({ healMode: 'auto' })]) })

    ensureExternalClaimForMcpCall(deps, 'run-1', 'sess-1', 'claude')

    expect(broker.claim).not.toHaveBeenCalled()
    expect(broker.touch).not.toHaveBeenCalled()
  })

  it('does nothing once the run has finished', () => {
    // Claiming a terminal run would show a live heal owner on a run nobody can heal.
    const { broker, deps } = externalDeps({}, { status: 'passed' })

    ensureExternalClaimForMcpCall(deps, 'run-1', 'sess-1', 'claude')

    expect(broker.claim).not.toHaveBeenCalled()
    expect(broker.touch).not.toHaveBeenCalled()
  })

  it('does nothing for a runId the store has never heard of', () => {
    const broker = fakeBroker()
    const deps = asDeps({ broker, store: fakeStore([], []) })

    ensureExternalClaimForMcpCall(deps, 'ghost', 'sess-1', 'claude')

    expect(broker.claim).not.toHaveBeenCalled()
    expect(broker.touch).not.toHaveBeenCalled()
  })
})
