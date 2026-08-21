import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetail, RunStoreEvent, RunStoreEventListener } from '../features/runs/logic/run-store'
import type { CanaryLabMcpDeps } from './tool-schemas'
import {
  BOOT_SESSION_MESSAGE,
  WAIT_FOR_HEAL_TASK_WINDOW_MS,
  bootSessionValue,
  classifyWaitForHealTask,
  dirtyTestsWarning,
  healFixOutcome,
  healWaitNext,
  isActiveBootRun,
  stillWaitingValue,
  waitForHealTask,
  type WaitForHealTaskResult,
} from './heal-task-wait'

// The wait_for_heal_task decision layer: what a blocked external heal client is
// told, and when. `server.smoke.wait-for-heal.test.ts` proves the same
// classifications end to end over a real MCP client; this suite drives the
// branches that a live run can only reach by racing — the still_waiting elapse,
// the mid-wait store event, and the heartbeat that fires while the wait blocks.
//
// Nothing here fakes a clock: every wait is given a 1ms window, or is resolved
// by an event the test emits itself. A fake clock would decouple the timeout
// from the heartbeat interval that shares it, which is the interleaving the
// `settled` guard exists for.

let tmpDir: string
let logsDir: string

function runDetail(manifest: Record<string, unknown> = {}, over: Record<string, unknown> = {}): RunDetail {
  return {
    runId: 'run-1',
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
    ...over,
  } as unknown as RunDetail
}

/** A run parked exactly where an external client is expected to pick it up. */
function needsHealDetail(manifest: Record<string, unknown> = {}): RunDetail {
  return runDetail({
    healMode: 'external',
    lifecycle: { phase: 'waiting-for-signal', activeCycle: 1 },
    ...manifest,
  })
}

/** A store fake with a real listener list: `waitForHealTask` unsubscribes on
 *  finish, so a set that ignored `offEvent` would let a resolved wait keep
 *  reacting and hide the leak this suite is meant to catch. */
function fakeStore(get: () => RunDetail | undefined) {
  const listeners = new Set<RunStoreEventListener>()
  return {
    logsDir,
    get,
    onEvent: (l: RunStoreEventListener) => { listeners.add(l) },
    offEvent: (l: RunStoreEventListener) => { listeners.delete(l) },
    emit: (event: RunStoreEvent) => { for (const l of [...listeners]) l(event) },
    listenerCount: () => listeners.size,
  }
}

function ownedBroker(over: Record<string, unknown> = {}) {
  return {
    assertOwnership: () => ({ ok: true }),
    getSession: () => ({ sessionId: 'sess-1', clientKind: 'claude' }),
    claim: () => ({ accepted: true, session: { sessionId: 'sess-1' } }),
    touch: () => ({ ok: true }),
    heartbeat: vi.fn(() => ({ ok: true })),
    ...over,
  }
}

function asDeps(deps: Record<string, unknown>): CanaryLabMcpDeps {
  return deps as unknown as CanaryLabMcpDeps
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-heal-wait-')))
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('healWaitNext', () => {
  it('names wait_for_heal_task as the machine-readable next step', () => {
    // start_run / signal_run carry this so a skill-less client blocks on the
    // wait instead of inventing a get_run_snapshot poll loop.
    expect(healWaitNext()).toEqual({ nextSteps: ['wait_for_heal_task'] })
  })
})

describe('isActiveBootRun', () => {
  it('is true only for an active run whose executionType is boot', () => {
    expect(isActiveBootRun(runDetail({ executionType: 'boot', status: 'running' }))).toBe(true)
    expect(isActiveBootRun(runDetail({ executionType: 'boot', status: 'aborted' }))).toBe(false)
    // The default executionType is 'run', so an ordinary healing run is not one.
    expect(isActiveBootRun(runDetail({ status: 'healing' }))).toBe(false)
    expect(isActiveBootRun(null)).toBe(false)
    expect(isActiveBootRun(undefined)).toBe(false)
  })
})

describe('stillWaitingValue', () => {
  it('builds the cursor from the live phase, cycle count and status', () => {
    const value = stillWaitingValue('run-1', runDetail({
      status: 'running', healCycles: 3, lifecycle: { phase: 'running-tests' },
    }))

    expect(value).toEqual({
      type: 'still_waiting',
      runId: 'run-1',
      status: 'running',
      lifecycle: { phase: 'running-tests' },
      cursor: 'running-tests:3:running',
      nextSteps: ['wait_for_heal_task'],
    })
  })

  it('still answers when the run record has gone', () => {
    // A deleted/unreadable record must not turn the elapse into a crash — the
    // agent still needs a non-terminal answer it can re-call on.
    expect(stillWaitingValue('run-1', null)).toEqual({
      type: 'still_waiting',
      runId: 'run-1',
      status: null,
      lifecycle: null,
      cursor: 'unknown:0:unknown',
      nextSteps: ['wait_for_heal_task'],
    })
  })

  it('falls back to unknown when the manifest carries no lifecycle', () => {
    expect(stillWaitingValue('run-1', runDetail({ status: 'running' })).cursor).toBe('unknown:1:running')
  })
})

describe('bootSessionValue', () => {
  it('says services are held and only abort_run stops them', () => {
    const value = bootSessionValue(runDetail({ executionType: 'boot', status: 'running' }))

    expect(value).toMatchObject({
      type: 'boot_session',
      runId: 'run-1',
      executionType: 'boot',
      status: 'running',
      claimed: false,
      lifecycle: null,
      message: BOOT_SESSION_MESSAGE,
    })
    // A boot session has no heal task, so the one next step must not be a wait.
    expect(value.nextSteps[0]).toContain('abort_run')
    expect(value.nextSteps[0]).not.toContain('wait_for_heal_task')
  })

  it('carries the lifecycle through when the manifest has one', () => {
    expect(bootSessionValue(runDetail({
      executionType: 'boot', status: 'running', lifecycle: { phase: 'booting' },
    })).lifecycle).toEqual({ phase: 'booting' })
  })
})

describe('healFixOutcome', () => {
  it('says nothing when the run captured no diff', () => {
    expect(healFixOutcome(runDetail({ status: 'passed' }))).toBeUndefined()
    expect(healFixOutcome(runDetail({ status: 'passed', fixCapture: { repos: [] } }))).toBeUndefined()
  })

  it('pairs each captured repo with its pull request or the reason there is none', () => {
    const outcome = healFixOutcome(runDetail({
      status: 'passed',
      fixCapture: { repos: [{ repoName: 'shop', files: 2 }, { repoName: 'api', files: 1 }] },
      proposedPrs: [{ repoName: 'shop', url: 'https://github.com/acme/shop/pull/7' }],
      prAttempt: {
        results: [
          { repoName: 'api', ok: false, reason: 'no gh credentials' },
          // An ok result and a reasonless failure both drop out: neither is a
          // reason the agent could relay.
          { repoName: 'shop', ok: true },
          { repoName: 'web', ok: false },
        ],
      },
    }))

    expect(outcome).toEqual({
      repos: [
        { repoName: 'shop', files: 2, pr: 'https://github.com/acme/shop/pull/7' },
        { repoName: 'api', files: 1, noPrReason: 'no gh credentials' },
      ],
      // The note is the whole point of the block: without it a skill-less agent
      // opens a second pull request for a diff Canary Lab already pushed.
      note: expect.stringContaining('Do NOT open or push one yourself'),
    })
  })
})

describe('dirtyTestsWarning', () => {
  it('is absent with no store, no record, or a clean record', () => {
    expect(dirtyTestsWarning(asDeps({}), 'checkout')).toBeUndefined()
    expect(dirtyTestsWarning(asDeps({ dirtySpecStore: { get: () => undefined } }), 'checkout')).toBeUndefined()
    expect(dirtyTestsWarning(
      asDeps({ dirtySpecStore: { get: () => ({ status: 'clean', dirtySpecs: [], message: '' }) } }),
      'checkout',
    )).toBeUndefined()
  })

  it('relays the store message verbatim for a dirty feature', () => {
    const rec = {
      status: 'dirty',
      dirtySpecs: [{ file: 'e2e/checkout.spec.ts' }, { file: 'e2e/cart.spec.ts' }],
      message: '⚠️ Tests have been modified, please review.',
    }

    // Verbatim relay, not a rewording: this is an awareness signal the agent
    // passes on, and Canary never blocks or gates on it.
    expect(dirtyTestsWarning(asDeps({ dirtySpecStore: { get: () => rec } }), 'checkout')).toEqual({
      dirty: true,
      specs: ['e2e/checkout.spec.ts', 'e2e/cart.spec.ts'],
      message: '⚠️ Tests have been modified, please review.',
    })
  })
})

describe('classifyWaitForHealTask', () => {
  const dirtyStore = {
    get: () => ({ status: 'dirty', dirtySpecs: [{ file: 'e2e/checkout.spec.ts' }], message: 'review the specs' }),
  }

  function classify(detail: RunDetail | undefined, over: Record<string, unknown> = {}): WaitForHealTaskResult | null {
    return classifyWaitForHealTask(
      asDeps({ store: fakeStore(() => detail), broker: ownedBroker(), ...over }),
      'run-1',
      'sess-1',
    )
  }

  it('reports an unknown run by id', () => {
    expect(classify(undefined)).toEqual({ ok: false, error: 'run not found: run-1' })
  })

  it('short-circuits a boot session before it looks for a heal task', () => {
    const result = classify(runDetail({ executionType: 'boot', status: 'running' }))

    expect(result).toMatchObject({ ok: true, value: { type: 'boot_session' } })
  })

  it('reports a passed run with its counts', () => {
    const result = classify(runDetail({ status: 'passed' }))

    expect(result).toMatchObject({
      ok: true,
      value: { type: 'passed', runId: 'run-1', counts: { failed: 1 } },
    })
    expect(result).not.toHaveProperty('value.dirtyTests')
    expect(result).not.toHaveProperty('value.fix')
  })

  it('adds the fix block and the dirty-tests warning to a passed run that has them', () => {
    const result = classify(
      runDetail({ status: 'passed', fixCapture: { repos: [{ repoName: 'shop', files: 1 }] } }),
      { dirtySpecStore: dirtyStore },
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        type: 'passed',
        dirtyTests: { dirty: true, specs: ['e2e/checkout.spec.ts'] },
        fix: { repos: [{ repoName: 'shop', files: 1 }] },
      },
    })
  })

  for (const status of ['failed', 'aborted'] as const) {
    it(`reports a ${status} run as failed, keeping its status`, () => {
      const result = classify(runDetail({ status }), { dirtySpecStore: dirtyStore })

      // The verdict is the run's own status, not a softened one.
      expect(result).toMatchObject({
        ok: true,
        value: { type: 'failed', status, counts: { failed: 1 }, dirtyTests: { dirty: true } },
      })
    })
  }

  for (const status of ['passed', 'failed'] as const) {
    it(`reports a ${status} run that never wrote a summary as zero counts, not as a pass`, () => {
      // A run that died before the reporter wrote e2e-summary.json has no
      // evidence at all. Reporting nothing is right; inventing a passed count
      // from `total` is the rounding-up this product exists to prevent.
      const result = classify(runDetail({ status }, { summary: undefined }))

      expect(result).toMatchObject({
        ok: true,
        value: { summary: null, counts: { passed: 0, failed: 0, totalKnown: 0 } },
      })
      expect(result).not.toHaveProperty('value.dirtyTests')
    })
  }

  it('names the holder when another session owns the claim', () => {
    const broker = ownedBroker({
      assertOwnership: () => ({ ok: false, reason: 'session-mismatch', currentSession: { sessionId: 'sess-other' } }),
    })

    expect(classify(needsHealDetail(), { broker })).toEqual({
      ok: false,
      error: 'session-mismatch: run is held by sess-other',
    })
  })

  it('refuses an unclaimed run', () => {
    const broker = ownedBroker({ assertOwnership: () => ({ ok: false, reason: 'no-claim' }) })

    expect(classify(needsHealDetail(), { broker })).toEqual({
      ok: false,
      error: 'no external heal claim for run: run-1',
    })
  })

  it('has no answer yet for an active run that is not parked for a signal', () => {
    // null is not a verdict — it is what makes waitForHealTask block instead of
    // handing the agent a premature terminal result.
    expect(classify(runDetail({ healMode: 'external', lifecycle: { phase: 'running-tests' } }))).toBeNull()
    expect(classify(runDetail({ healMode: 'auto', lifecycle: { phase: 'waiting-for-signal' } }))).toBeNull()
  })

  it('hands over the full heal context on cycle 1', () => {
    fs.mkdirSync(path.join(logsDir, 'runs', 'run-1'), { recursive: true })
    const result = classify(needsHealDetail(), { dirtySpecStore: dirtyStore })

    expect(result).toMatchObject({
      ok: true,
      value: {
        type: 'needs_heal',
        cycle: 1,
        dirtyTests: { dirty: true },
        context: { runId: 'run-1', failedTests: [{ failureId: 'checkout fails' }] },
      },
    })
    // Cycle 1 is where the procedure ships, including the repair rule itself.
    const nextSteps = (result as { value: { context: { nextSteps?: string[] } } }).value.context.nextSteps
    expect(nextSteps?.[0]).toContain('Fix app/service code, not tests')
  })

  it('slims the context from cycle 2 and reads the cycle off the active lifecycle', () => {
    const result = classify(needsHealDetail({ lifecycle: { phase: 'waiting-for-signal', activeCycle: 2 } }))

    expect(result).toMatchObject({ ok: true, value: { type: 'needs_heal', cycle: 2 } })
    const context = (result as unknown as { value: { context: Record<string, unknown> } }).value.context
    expect(context).not.toHaveProperty('nextSteps')
    expect(context).not.toHaveProperty('healPrompt')
    expect(context.guidance).toContain('get_heal_context')
  })

  it('falls back to healCycles when the lifecycle names no active cycle', () => {
    const result = classify(needsHealDetail({
      healCycles: 4, lifecycle: { phase: 'waiting-for-signal' },
    }))

    // healCycles 4 >= 2, so the fallback also selects the slim variant.
    expect(result).toMatchObject({ ok: true, value: { type: 'needs_heal', cycle: 4 } })
  })

  it('reports the run as gone if the record vanishes between the two reads', () => {
    // The re-read exists because the context build is the expensive part; a run
    // deleted in that gap must read as "not found", not as an empty heal packet.
    let reads = 0
    const store = fakeStore(() => (reads++ === 0 ? needsHealDetail() : undefined))

    expect(classifyWaitForHealTask(asDeps({ store, broker: ownedBroker() }), 'run-1', 'sess-1'))
      .toEqual({ ok: false, error: 'run not found: run-1' })
  })
})

describe('waitForHealTask', () => {
  it('answers a boot session without claiming heal', async () => {
    const claim = vi.fn()
    const store = fakeStore(() => runDetail({ executionType: 'boot', status: 'running' }))

    const result = await waitForHealTask(
      asDeps({ store, broker: ownedBroker({ claim }) }), 'run-1', 'sess-1', 'claude', 90_000,
    )

    expect(result).toMatchObject({ ok: true, value: { type: 'boot_session' } })
    // No claim, no subscription: a boot session has no heal task to wait for.
    expect(claim).not.toHaveBeenCalled()
    expect(store.listenerCount()).toBe(0)
  })

  it('returns a task that is already waiting without subscribing', async () => {
    const store = fakeStore(() => needsHealDetail())

    const result = await waitForHealTask(
      asDeps({ store, broker: ownedBroker() }), 'run-1', 'sess-1', 'claude', 90_000,
    )

    expect(result).toMatchObject({ ok: true, value: { type: 'needs_heal' } })
    expect(store.listenerCount()).toBe(0)
  })

  it('claims an unclaimed external run before it blocks', async () => {
    const claim = vi.fn(() => ({ accepted: true, session: { sessionId: 'sess-1' } }))
    const store = fakeStore(() => runDetail({ healMode: 'external', status: 'running' }))
    const broker = ownedBroker({ claim, getSession: () => null })

    await waitForHealTask(asDeps({ store, broker }), 'run-1', 'sess-1', 'claude', 1)

    expect(claim).toHaveBeenCalledWith('run-1', { sessionId: 'sess-1', clientKind: 'claude' })
  })

  it('returns still_waiting when the window elapses on a live run', async () => {
    const store = fakeStore(() => runDetail({ healMode: 'external', status: 'running', lifecycle: { phase: 'running-tests' } }))
    const broker = ownedBroker()

    const result = await waitForHealTask(asDeps({ store, broker }), 'run-1', 'sess-1', 'claude', 1)

    expect(result).toMatchObject({
      ok: true,
      value: { type: 'still_waiting', status: 'running', cursor: 'running-tests:1:running' },
    })
    // still_waiting is not terminal, so the wait must have released its
    // subscription — a leaked listener would fire for every later re-call.
    expect(store.listenerCount()).toBe(0)
    // It heartbeats for the agent: that is why the client need not call heartbeat.
    expect(broker.heartbeat).toHaveBeenCalledWith('run-1', 'sess-1', 'waiting')
  })

  it('still returns still_waiting when the record disappears mid-window', async () => {
    let detail: RunDetail | undefined =
      runDetail({ healMode: 'external', status: 'running', lifecycle: { phase: 'running-tests' } })
    const store = fakeStore(() => detail)

    // The wait's whole setup — claim, immediate classify, first beat — runs
    // before the returned promise is pending, so dropping the record here is a
    // deletion during the block, which must still answer non-terminally.
    const wait = waitForHealTask(asDeps({ store, broker: ownedBroker() }), 'run-1', 'sess-1', 'claude', 1)
    detail = undefined

    await expect(wait).resolves.toMatchObject({ ok: true, value: { type: 'still_waiting', status: null } })
  })

  it('clamps an over-long requested window instead of rejecting it', async () => {
    let detail = runDetail({ healMode: 'external', status: 'running', lifecycle: { phase: 'running-tests' } })
    const store = fakeStore(() => detail)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const wait = waitForHealTask(asDeps({ store, broker: ownedBroker() }), 'run-1', 'sess-1', 'claude', 60 * 60 * 1000)

      // An old client asking for an hour gets a bounded block, not a request
      // that outlives its own JSON-RPC timeout.
      expect(setTimeoutSpy.mock.calls.some(([, ms]) => ms === WAIT_FOR_HEAL_TASK_WINDOW_MS)).toBe(true)

      // Resolve through the event path so the clamped timer never has to run.
      detail = needsHealDetail()
      store.emit({ kind: 'changed', runId: 'run-1' })
      await expect(wait).resolves.toMatchObject({ ok: true, value: { type: 'needs_heal' } })
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it('resolves as soon as the run parks for a signal', async () => {
    let detail = runDetail({ healMode: 'external', status: 'running', lifecycle: { phase: 'running-tests' } })
    const store = fakeStore(() => detail)

    const wait = waitForHealTask(asDeps({ store, broker: ownedBroker() }), 'run-1', 'sess-1', 'claude', 60_000)
    // Events for other runs share the one store channel — reacting to them
    // would classify (and answer) the wrong run.
    store.emit({ kind: 'changed', runId: 'other-run' })
    detail = needsHealDetail()
    // `index-changed` carries no runId at all: a list-level event the wait must
    // still re-check on, since it cannot tell whether this run moved.
    store.emit({ kind: 'index-changed' })

    await expect(wait).resolves.toMatchObject({ ok: true, value: { type: 'needs_heal' } })
    expect(store.listenerCount()).toBe(0)
  })

  it('skips the heartbeat once the run is terminal or gone', async () => {
    const broker = ownedBroker()
    const gone = fakeStore(() => undefined)
    await waitForHealTask(asDeps({ store: gone, broker }), 'run-1', 'sess-1', 'claude', 1)
    // The immediate classify answers "not found" before any beat.
    expect(broker.heartbeat).not.toHaveBeenCalled()

    // Active while the wait sets up, terminal by the time the first beat runs:
    // heartbeating a finished run would revive a dead claim. The ownership check
    // is the last thing the immediate classify does, so flipping there pins the
    // transition to exactly that gap rather than to a `store.get` call count.
    let finished = false
    const finishing = fakeStore(() => runDetail(finished
      ? { healMode: 'external', status: 'passed' }
      : { healMode: 'external', status: 'running', lifecycle: { phase: 'running-tests' } }))
    const finishingBroker = ownedBroker({
      heartbeat: broker.heartbeat,
      assertOwnership: () => { finished = true; return { ok: true } },
    })
    const result = await waitForHealTask(asDeps({ store: finishing, broker: finishingBroker }), 'run-1', 'sess-1', 'claude', 1)

    expect(broker.heartbeat).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, value: { type: 'passed' } })
  })

  it('resolves once when the heartbeat and the trailing re-check both see the task', async () => {
    // The real interleaving: the orchestrator parks the run for a signal after
    // the immediate classify, and the first beat's broker.heartbeat patches the
    // manifest — which emits `changed` and resolves the wait from inside the
    // setup. The trailing check() then classifies the same task again, so
    // without the settled guard the promise would be resolved twice and the
    // subscription removed against an already-empty listener set.
    let detail = runDetail({ healMode: 'external', status: 'running', lifecycle: { phase: 'running-tests' } })
    const store = fakeStore(() => detail)
    const offEvent = vi.spyOn(store, 'offEvent')
    const broker = ownedBroker({
      heartbeat: vi.fn(() => {
        detail = needsHealDetail()
        store.emit({ kind: 'changed', runId: 'run-1' })
        return { ok: true }
      }),
    })

    const result = await waitForHealTask(asDeps({ store, broker }), 'run-1', 'sess-1', 'claude', 60_000)

    expect(result).toMatchObject({ ok: true, value: { type: 'needs_heal' } })
    expect(offEvent).toHaveBeenCalledTimes(1)
  })
})
