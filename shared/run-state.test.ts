import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  HEARTBEAT_STALE_MS,
  HealSignalGate,
  createRunLifecycleEvent,
  deriveDisplayStatus,
  deriveRunActionAvailability,
  isActiveRunStatus,
  isQueuedRunStatus,
  isRestartableRunStatus,
  isStaleHeartbeat,
  isTerminalRunStatus,
  isUnsettledRunStatus,
  reduceRunLifecycleSnapshot,
  runBootPhase,
  type RunLifecycleSnapshot,
} from './run-state'

describe('run status predicates', () => {
  it('classifies terminal, active, and restartable states', () => {
    expect(isTerminalRunStatus('passed')).toBe(true)
    expect(isTerminalRunStatus('failed')).toBe(true)
    expect(isTerminalRunStatus('aborted')).toBe(true)
    expect(isTerminalRunStatus('running')).toBe(false)

    expect(isActiveRunStatus('running')).toBe(true)
    expect(isActiveRunStatus('healing')).toBe(true)
    expect(isActiveRunStatus('failed')).toBe(false)

    expect(isRestartableRunStatus('failed')).toBe(true)
    expect(isRestartableRunStatus('aborted')).toBe(true)
    expect(isRestartableRunStatus('passed')).toBe(false)

    // Queued is its own state: admitted but holding no processes or ports, so
    // it must not read as active (which would imply resources are in use).
    expect(isQueuedRunStatus('queued')).toBe(true)
    expect(isQueuedRunStatus('running')).toBe(false)
    expect(isQueuedRunStatus(null)).toBe(false)
    expect(isActiveRunStatus('queued')).toBe(false)

    // Unsettled is the recovery-path question — "is some process supposed to be
    // driving this" — and queued answers yes even though it holds no resources.
    // The recovery paths gated on `isActiveRunStatus` instead, which is how a
    // queued row from a dead server stayed active forever with a Stop that 404'd.
    expect(isUnsettledRunStatus('queued')).toBe(true)
    expect(isUnsettledRunStatus('running')).toBe(true)
    expect(isUnsettledRunStatus('healing')).toBe(true)
    expect(isUnsettledRunStatus('passed')).toBe(false)
    expect(isUnsettledRunStatus('failed')).toBe(false)
    expect(isUnsettledRunStatus('aborted')).toBe(false)
    expect(isUnsettledRunStatus(null)).toBe(false)
  })

  it('detects stale heartbeats without treating missing or invalid timestamps as stale', () => {
    const now = Date.parse('2026-05-12T00:10:30.000Z')
    expect(isStaleHeartbeat('2026-05-12T00:00:00.000Z', now)).toBe(true)
    expect(isStaleHeartbeat(new Date(now - HEARTBEAT_STALE_MS).toISOString(), now)).toBe(false)
    expect(isStaleHeartbeat(undefined, now)).toBe(false)
    expect(isStaleHeartbeat('not-a-date', now)).toBe(false)
  })
})

describe('run action availability', () => {
  it('derives action availability and shared disabled reasons', () => {
    const running = deriveRunActionAvailability('running')
    expect(running.pauseHeal.enabled).toBe(true)
    expect(running.stop.enabled).toBe(true)
    expect(running.cancelHeal.enabled).toBe(false)

    const healing = deriveRunActionAvailability('healing')
    expect(healing.cancelHeal.enabled).toBe(true)
    expect(healing.pauseHeal.reason).toContain('only while tests are running')

    const failed = deriveRunActionAvailability('failed')
    expect(failed.delete.enabled).toBe(true)
    expect(failed.restartHeal.enabled).toBe(true)
  })

  it('lets transient actions override display status and disable actions', () => {
    expect(deriveDisplayStatus('running', 'aborting')).toBe('aborting')
    const actions = deriveRunActionAvailability('running', 'aborting')
    expect(actions.stop.enabled).toBe(false)
    expect(actions.stop.reason).toContain('aborting')
  })
})

describe('run lifecycle reducer', () => {
  it('derives the manifest snapshot from the latest lifecycle event', () => {
    const event = createRunLifecycleEvent('pausing-for-heal', 'Pause accepted', {
      updatedAt: '2026-05-12T00:00:00.000Z',
      detail: 'Stopping Playwright after 1 failure.',
      severity: 'warning',
    })

    expect(reduceRunLifecycleSnapshot(undefined, event)).toEqual({
      phase: 'pausing-for-heal',
      headline: 'Pause accepted',
      detail: 'Stopping Playwright after 1 failure.',
      updatedAt: '2026-05-12T00:00:00.000Z',
    })
  })

  it('keeps targeted rerun metadata sticky across later lifecycle events', () => {
    const previous: RunLifecycleSnapshot = {
      phase: 'rerunning-tests',
      headline: 'Targeted rerun selected',
      updatedAt: '2026-05-12T00:00:00.000Z',
      targetedRerun: {
        selected: 18,
        total: 21,
        mode: 'failed-and-pending',
        reason: 'Rerunning tests that had not passed yet.',
      },
    }
    const final = createRunLifecycleEvent('failed', 'Run failed', {
      updatedAt: '2026-05-12T00:01:00.000Z',
      severity: 'error',
    })

    expect(reduceRunLifecycleSnapshot(previous, final)).toEqual({
      phase: 'failed',
      headline: 'Run failed',
      updatedAt: '2026-05-12T00:01:00.000Z',
      targetedRerun: previous.targetedRerun,
    })
  })
})

describe('HealSignalGate', () => {
  afterEach(() => vi.useRealTimers())

  it('wakes on acceptance without consuming the signal or leaving a timer', async () => {
    vi.useFakeTimers()
    const gate = new HealSignalGate()
    gate.beginWaiting()
    const woke = vi.fn()
    const waiting = gate.waitForSignal(1000).then(woke)
    await vi.advanceTimersByTimeAsync(10)
    expect(woke).not.toHaveBeenCalled()
    gate.observe('restart', { hypothesis: 'fixed' })
    await waiting
    expect(woke).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await gate.waitForSignal(1000)
    expect(vi.getTimerCount()).toBe(0)
    expect(gate.consume()).toEqual({ kind: 'restart', body: { hypothesis: 'fixed' } })
  })

  it('times out for liveness checks and can then wait for another signal', async () => {
    vi.useFakeTimers()
    const gate = new HealSignalGate()
    gate.beginWaiting()
    const woke = vi.fn()
    const waiting = gate.waitForSignal(100).then(woke)
    await vi.advanceTimersByTimeAsync(99)
    expect(woke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await waiting
    expect(woke).toHaveBeenCalledOnce()
    expect(gate.consume()).toBeNull()
    const next = gate.waitForSignal(100)
    gate.observe('rerun', {})
    await next
    expect(vi.getTimerCount()).toBe(0)
    expect(gate.consume()?.kind).toBe('rerun')
  })

  it('ignores signals when the runner is not waiting', () => {
    const gate = new HealSignalGate()
    expect(gate.observe('restart', {})).toEqual({
      accepted: false,
      kind: 'restart',
      reason: 'not-waiting-for-signal',
    })
  })

  it('accepts one pending signal while waiting and ignores duplicates', () => {
    const gate = new HealSignalGate()
    gate.beginWaiting()

    expect(gate.observe('restart', { hypothesis: 'fix' })).toEqual({
      accepted: true,
      signal: { kind: 'restart', body: { hypothesis: 'fix' } },
    })
    expect(gate.observe('rerun', {})).toEqual({
      accepted: false,
      kind: 'rerun',
      reason: 'signal-already-pending',
      pendingKind: 'restart',
    })
    expect(gate.isReadyForSignal()).toBe(false)
    expect(gate.consume()).toEqual({ kind: 'restart', body: { hypothesis: 'fix' } })
    expect(gate.isReadyForSignal()).toBe(true)
    gate.endWaiting()
    expect(gate.isReadyForSignal()).toBe(false)
    expect(gate.consume()).toBeNull()
  })
})

it('retains lifecycle recovery metadata and supplies a timestamp when omitted', () => {
  const opts = {
    detail: 'Service failed', activeCycle: 0,
    lastSignal: { kind: 'restart' as const, status: 'accepted' as const },
    restartPlan: { restarted: ['app'], kept: [] },
    targetedRerun: { selected: 1, total: 2, mode: 'failed-only' as const, reason: 'retry' },
    abortReason: { reason: 'failed readiness', service: 'app' }, id: 'event',
  }
  const before = Date.now()
  const event = createRunLifecycleEvent('restarting-services', 'Restarting', opts)
  expect(event).toMatchObject({ ...opts, phase: 'restarting-services', headline: 'Restarting' })
  expect(Date.parse(event.updatedAt)).toBeGreaterThanOrEqual(before)
  expect(Date.parse(event.updatedAt)).toBeLessThanOrEqual(Date.now())
  expect(event).not.toHaveProperty('severity')
})

it.each([
  ['spawn-failed', 'spawn'], ['process-exited', 'process-exit'], ['health-timeout', 'readiness'],
  ['dependency-incompatible', 'configuration'], ['compiler-failed', 'compilation'],
] as const)('classifies %s as a %s failure', (reason, phase) => {
  expect(runBootPhase(reason)).toBe(phase)
})
