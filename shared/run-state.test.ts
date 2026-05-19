import { describe, expect, it } from 'vitest'
import {
  HEARTBEAT_STALE_MS,
  HealSignalGate,
  createRunLifecycleEvent,
  deriveDisplayStatus,
  deriveRunActionAvailability,
  isActiveRunStatus,
  isRestartableRunStatus,
  isStaleHeartbeat,
  isTerminalRunStatus,
  reduceRunLifecycleSnapshot,
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
    expect(gate.consume()).toEqual({ kind: 'restart', body: { hypothesis: 'fix' } })
    expect(gate.consume()).toBeNull()
  })
})
