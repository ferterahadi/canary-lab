import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetail } from '../../features/runs/logic/run-store'
import { registerHealFlowTools } from './heal-flow'
import { captureTools } from './__fixtures__/tool-group-harness'

// The external heal-flow tools: claim/release/heartbeat, the blocking wait, the
// per-cycle signal, and the hand-off back to a local heal mode.
//
// Two things here are load-bearing rather than incidental. First, every refusal
// is a NAMED refusal — "already-claimed by session X", "run not active
// (status=…)", "session-mismatch: run is held by Y". A bare error would read to
// an agent as "the tool is broken" and invite a retry loop against a run it does
// not own. Second, signal_run only accepts a restart/rerun that carries a
// diagnosis: the journal is built from that hypothesis plus the runner's own git
// diff, so an unexplained signal would leave a cycle with no evidence of why the
// code changed.

let tmpDir: string
let logsDir: string

function runDetail(manifest: Record<string, unknown> = {}): RunDetail {
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
  } as unknown as RunDetail
}

function harness(over: Record<string, unknown> = {}) {
  const { store: storeOver, broker: brokerOver, ...rest } = over
  const broker = Object.assign({
    claim: vi.fn(() => ({ accepted: true, session: { sessionId: 'sess-1', clientKind: 'claude' } })),
    release: vi.fn(() => ({ released: true })),
    heartbeat: vi.fn(() => ({ ok: true, session: { sessionId: 'sess-1', status: 'connected' } })),
    getSession: vi.fn(() => ({ sessionId: 'sess-1', clientKind: 'claude' })),
    touch: vi.fn(() => ({ ok: true })),
    assertOwnership: vi.fn(() => ({ ok: true })),
    bumpCycle: vi.fn(),
  }, brokerOver as Record<string, unknown> | undefined)
  const store = Object.assign({
    logsDir,
    get: (): RunDetail | undefined => undefined,
    onEvent: () => undefined,
    offEvent: () => undefined,
  }, storeOver as Record<string, unknown> | undefined)
  return { ...captureTools(registerHealFlowTools, { store, broker, ...rest }), broker, store }
}

/** The three fields every claim-aware tool takes. */
const SESSION = { runId: 'run-1', session_id: 'sess-1', client_kind: 'claude' as const }

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-heal-flow-')))
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('claim_heal', () => {
  it('reports an unknown run by id', async () => {
    const { text, broker } = harness()

    expect(await text('claim_heal', SESSION)).toBe('run not found: run-1')
    expect(broker.claim).not.toHaveBeenCalled()
  })

  it('claims a real run and forwards the optional client identity', async () => {
    const { call, broker } = harness({ store: { get: () => runDetail() } })

    expect(await call('claim_heal', {
      ...SESSION, client_version: '2.1.0', conversation_name: 'fix checkout',
    })).toEqual({ accepted: true, session: { sessionId: 'sess-1', clientKind: 'claude' } })
    expect(broker.claim).toHaveBeenCalledWith('run-1', {
      sessionId: 'sess-1',
      clientKind: 'claude',
      clientVersion: '2.1.0',
      conversationName: 'fix checkout',
    })
  })

  it('omits the optional identity fields the caller left out', async () => {
    const { call, broker } = harness({ store: { get: () => runDetail() } })

    await call('claim_heal', SESSION)

    expect(broker.claim).toHaveBeenCalledWith('run-1', { sessionId: 'sess-1', clientKind: 'claude' })
  })

  it('names the current holder when someone else has the claim', async () => {
    const { text } = harness({
      store: { get: () => runDetail() },
      broker: {
        claim: () => ({
          accepted: false,
          reason: 'already-claimed',
          currentSession: { sessionId: 'sess-other', clientKind: 'codex' },
        }),
      },
    })

    expect(await text('claim_heal', SESSION)).toBe('already-claimed by session sess-other (codex)')
  })

  it('explains a suppressed runner PTY without making it look like a broken run', async () => {
    const { text } = harness({
      store: { get: () => runDetail() },
      broker: { claim: () => ({ accepted: false, reason: 'client-kind-not-allowed', clientKind: 'claude-pty' }) },
    })

    const message = await text('claim_heal', { ...SESSION, client_kind: 'claude-pty' })

    // Suppression is a policy, not a failure: the message has to say the run
    // still works and point at the interactive clients that may drive heal.
    expect(message).toContain('client-kind-not-allowed')
    expect(message).toContain('claude-pty')
    expect(message).toContain('The run can still be run/verified')
  })
})

describe('release_heal', () => {
  it('reports the release, and reports a no-op the same way', async () => {
    const released = harness({ broker: { release: () => ({ released: true }) } })
    expect(await released.call('release_heal', { runId: 'run-1', session_id: 'sess-1' }))
      .toEqual({ released: true })

    // A session that never held the claim is not an error — releasing twice, or
    // from the wrong session, must not fail a shutting-down conversation.
    const noop = harness({ broker: { release: () => ({ released: false }) } })
    expect(await noop.call('release_heal', { runId: 'run-1', session_id: 'sess-other' }))
      .toEqual({ released: false })
  })
})

describe('heartbeat', () => {
  it('refreshes liveness through the broker', async () => {
    const { call, broker } = harness({ store: { get: () => runDetail({ healMode: 'external' }) } })

    expect(await call('heartbeat', { ...SESSION, status: 'healing' }))
      .toEqual({ ok: true, session: { sessionId: 'sess-1', status: 'connected' } })
    expect(broker.heartbeat).toHaveBeenCalledWith('run-1', 'sess-1', 'healing')
  })

  it('names the reason a heartbeat was rejected', async () => {
    const { text } = harness({ broker: { heartbeat: () => ({ ok: false, reason: 'no-claim' }) } })

    expect(await text('heartbeat', { ...SESSION, status: 'connected' }))
      .toBe('heartbeat rejected: no-claim')
  })
})

describe('wait_for_heal_task', () => {
  it('returns the classified task', async () => {
    const { call } = harness({ store: { get: () => runDetail({ status: 'passed' }) } })

    expect(await call('wait_for_heal_task', { ...SESSION, timeout_ms: 1 }))
      .toMatchObject({ type: 'passed', runId: 'run-1' })
  })

  it('surfaces the wait\'s own refusal as a tool error', async () => {
    const { text } = harness()

    expect(await text('wait_for_heal_task', { ...SESSION, timeout_ms: 1 }))
      .toBe('run not found: run-1')
  })
})

describe('signal_run', () => {
  const DIAGNOSIS = { hypothesis: '  stale cart total  ', fixDescription: '  recompute on add  ' }

  function signalHarness(over: Record<string, unknown> = {}) {
    return harness({ store: { get: () => runDetail({ healMode: 'external' }) }, ...over })
  }

  it('reports an unknown run by id', async () => {
    expect(await harness().text('signal_run', { runId: 'run-1', kind: 'rerun', client_kind: 'claude', ...DIAGNOSIS }))
      .toBe('run not found: run-1')
  })

  it('refuses a run that has already finished', async () => {
    const { text } = harness({ store: { get: () => runDetail({ status: 'passed' }) } })

    // The status is in the message because the agent's next move depends on it:
    // a finished run is re-driven with start_run(run_ref), not with a signal.
    expect(await text('signal_run', { runId: 'run-1', kind: 'rerun', client_kind: 'claude', ...DIAGNOSIS }))
      .toBe('run not active (status=passed)')
  })

  for (const [label, args] of [
    ['neither field', { kind: 'restart' }],
    ['only a hypothesis', { kind: 'rerun', hypothesis: 'stale cart total' }],
    ['a blank fixDescription', { kind: 'restart', hypothesis: 'stale cart total', fixDescription: '   ' }],
  ] as const) {
    it(`refuses a restart/rerun carrying ${label}`, async () => {
      const { text, broker } = signalHarness()

      expect(await text('signal_run', { runId: 'run-1', client_kind: 'claude', ...args }))
        .toBe('restart/rerun signal requires hypothesis and fixDescription')
      // Nothing was written, so the cycle counter must not have moved either.
      expect(broker.bumpCycle).not.toHaveBeenCalled()
    })
  }

  it('writes a restart signal with the trimmed diagnosis and bumps the cycle', async () => {
    const { call, broker } = signalHarness()

    const out = await call('signal_run', { ...SESSION, kind: 'restart', ...DIAGNOSIS })

    expect(out).toMatchObject({
      accepted: true, kind: 'restart', runId: 'run-1',
      // The result steers the agent back into the blocking wait rather than a
      // poll loop of its own.
      nextSteps: ['wait_for_heal_task'],
    })
    expect(JSON.parse(fs.readFileSync(String(out.path), 'utf-8')))
      .toEqual({ hypothesis: 'stale cart total', fixDescription: 'recompute on add' })
    expect(broker.bumpCycle).toHaveBeenCalledWith('run-1')
    // A session id was supplied, so liveness is refreshed off the signal itself.
    expect(broker.touch).toHaveBeenCalledWith('run-1', 'sess-1')
  })

  it('writes a bare heal signal with no diagnosis, and without a session id', async () => {
    const { call, broker } = signalHarness()

    const out = await call('signal_run', { runId: 'run-1', kind: 'heal', client_kind: 'claude' })

    // `heal` re-enters the heal loop rather than reporting a fix, so it carries
    // no hypothesis — and an anonymous caller must not be touched as a holder.
    expect(fs.readFileSync(String(out.path), 'utf-8')).toBe('{}')
    expect(broker.touch).not.toHaveBeenCalled()
  })

  it('names the holder when another session signals the run', async () => {
    const { text } = signalHarness({
      broker: {
        assertOwnership: () => ({ ok: false, reason: 'session-mismatch', currentSession: { sessionId: 'sess-other' } }),
      },
    })

    expect(await text('signal_run', { ...SESSION, session_id: 'sess-other', kind: 'rerun', ...DIAGNOSIS }))
      .toBe('session-mismatch: run is held by sess-other')
  })

  it('still names a mismatch whose holder has already gone', async () => {
    const { text } = signalHarness({
      broker: { assertOwnership: () => ({ ok: false, reason: 'session-mismatch' }) },
    })

    expect(await text('signal_run', { ...SESSION, kind: 'rerun', ...DIAGNOSIS }))
      .toBe('session-mismatch: run is held by undefined')
  })

  it('accepts a signal for a run nobody has claimed', async () => {
    const { call } = signalHarness({
      broker: { assertOwnership: () => ({ ok: false, reason: 'no-claim' }) },
    })

    // Only a mismatch blocks. An unclaimed run belongs to whoever is driving it
    // — usually the web UI's manual heal — so the signal goes through.
    expect(await call('signal_run', { runId: 'run-1', kind: 'heal', client_kind: 'claude' }))
      .toMatchObject({ accepted: true })
  })

  it('reports a write failure instead of letting it escape as a tool crash', async () => {
    // A `logs` path that is a FILE, not a directory: the signal writer has no
    // try/catch of its own, so an unhandled throw would hand the client a
    // protocol error with nothing it could act on.
    const brokenLogs = path.join(tmpDir, 'logs-file')
    fs.writeFileSync(brokenLogs, 'not a directory')
    const { text } = harness({
      store: { logsDir: brokenLogs, get: () => runDetail({ healMode: 'external' }) },
    })

    expect(await text('signal_run', { ...SESSION, kind: 'rerun', ...DIAGNOSIS }))
      .toMatch(/^could not write signal: .*ENOTDIR/)
  })
})

describe('handoff_heal', () => {
  const HANDOFF = { runId: 'run-1', to: 'manual' as const, session_id: 'sess-1', confirm: true as const }

  it('is guarded against an accidental handoff', () => {
    const { configs } = harness()

    expect(configs.get('handoff_heal')?.annotations).toMatchObject({ destructiveHint: true })
  })

  it('says so when the hand-off wiring is absent', async () => {
    const { text } = harness()

    expect(await text('handoff_heal', HANDOFF)).toBe('handoffHeal dependency is not configured')
  })

  it('forwards the target mode and guidance, and returns the success body', async () => {
    const handoffHeal = vi.fn(async () => ({ statusCode: 200, body: { mode: 'manual', restarted: false } }))
    const { call } = harness({ handoffHeal })

    expect(await call('handoff_heal', { ...HANDOFF, to: 'claude', guidance: 'start from the cart total' }))
      .toEqual({ mode: 'manual', restarted: false })
    expect(handoffHeal).toHaveBeenCalledWith('run-1', 'claude', 'sess-1', 'start from the cart total')
  })

  it('renders a structured refusal as reason plus message', async () => {
    const { text } = harness({
      handoffHeal: async () => ({
        statusCode: 409,
        body: { reason: 'active-run-manual-only', message: 'the orchestrator cannot hot-swap a local agent' },
      }),
    })

    expect(await text('handoff_heal', { ...HANDOFF, to: 'codex' }))
      .toBe('active-run-manual-only: the orchestrator cannot hot-swap a local agent')
  })

  it('renders a reason with no message, a plain-string body, and a bodyless status', async () => {
    const reasonOnly = harness({ handoffHeal: async () => ({ statusCode: 409, body: { reason: 'run-not-found' } }) })
    expect(await reasonOnly.text('handoff_heal', HANDOFF)).toBe('run-not-found')

    const stringBody = harness({ handoffHeal: async () => ({ statusCode: 500, body: 'heal agent registry is gone' }) })
    expect(await stringBody.text('handoff_heal', HANDOFF)).toBe('heal agent registry is gone')

    // Nothing readable in the body at all — the status code is the only fact
    // there is, and it beats an empty error string.
    const empty = harness({ handoffHeal: async () => ({ statusCode: 503, body: null }) })
    expect(await empty.text('handoff_heal', HANDOFF)).toBe('handoff failed (503)')
  })

  it('surfaces a rejected hand-off', async () => {
    const { text } = harness({
      handoffHeal: async () => { throw new Error('run is in a worktree that no longer exists') },
    })

    expect(await text('handoff_heal', HANDOFF)).toBe('run is in a worktree that no longer exists')
  })
})
