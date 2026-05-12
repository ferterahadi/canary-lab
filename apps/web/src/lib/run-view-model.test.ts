import { describe, expect, it } from 'vitest'
import type { RunDetail, RunIndexEntry, RunStatus, TransientAction } from '../api/types'
import { deriveRunViewModel } from './run-view-model'

function detail(overrides: Partial<RunDetail['manifest']> = {}): RunDetail {
  return {
    runId: overrides.runId ?? 'run-1',
    manifest: {
      runId: overrides.runId ?? 'run-1',
      feature: 'checkout',
      startedAt: '2026-05-08T00:00:00.000Z',
      status: overrides.status ?? 'running',
      healCycles: 0,
      services: [],
      ...overrides,
    },
  }
}

describe('deriveRunViewModel', () => {
  it('uses lifecycle as the shared headline and timeline source', () => {
    const vm = deriveRunViewModel({
      ...detail({
        status: 'healing',
        lifecycle: {
          phase: 'waiting-for-signal',
          headline: 'Waiting for heal signal',
          detail: 'The runner is waiting for .restart.',
          updatedAt: '2026-05-08T00:00:01.000Z',
        },
      }),
      lifecycleEvents: [
        {
          phase: 'pausing-for-heal',
          headline: 'Pause accepted',
          updatedAt: '2026-05-08T00:00:00.000Z',
          severity: 'warning',
        },
      ],
    })

    expect(vm.displayStatus).toBe('healing')
    expect(vm.headline).toBe('Waiting for heal signal')
    expect(vm.subtext).toBe('The runner is waiting for .restart.')
    expect(vm.actions.cancelHeal.enabled).toBe(true)
    expect(vm.actions.pauseHeal.enabled).toBe(false)
    expect(vm.recoveryTimeline).toHaveLength(1)
    expect(vm.recoveryTimeline[0].headline).toBe('Pause accepted')
  })

  it('overlays transient actions consistently across consumers', () => {
    const vm = deriveRunViewModel(detail({ status: 'running' }), 'pausing')

    expect(vm.displayStatus).toBe('pausing')
    expect(vm.headline).toBe('Pausing for heal')
    expect(vm.actions.pauseHeal.enabled).toBe(false)
    expect(vm.actions.pauseHeal.reason).toContain('pausing')
  })

  it.each([
    ['aborting', 'Stopping run'],
    ['deleting', 'Deleting run'],
    ['cancelling-heal', 'Cancelling heal'],
  ] satisfies Array<[TransientAction, string]>)('uses the %s transient headline and disables all actions', (transient, headline) => {
    const vm = deriveRunViewModel(detail({ status: 'failed' }), transient)

    expect(vm.displayStatus).toBe(transient)
    expect(vm.headline).toBe(headline)
    expect(Object.values(vm.actions).every((action) => !action.enabled)).toBe(true)
    expect(vm.actions.delete.reason).toContain(transient.replace(/-/g, ' '))
  })

  it('surfaces terminal lifecycle alerts without treating pending journal as active state', () => {
    const vm = deriveRunViewModel(detail({
      status: 'aborted',
      lifecycle: {
        phase: 'aborted',
        headline: 'Run aborted',
        updatedAt: '2026-05-08T00:00:03.000Z',
        abortReason: { reason: 'service-health-failed', service: 'ngrok tunnel' },
      },
    }))

    expect(vm.primaryAlert).toEqual({
      tone: 'warning',
      message: 'Run aborted because ngrok tunnel failed health checks.',
    })
    expect(vm.actions.restartHeal.enabled).toBe(true)
    expect(vm.actions.delete.enabled).toBe(true)
  })

  it.each([
    ['running', 'Running tests', 'info'],
    ['healing', 'Healing', 'info'],
    ['passed', 'Run passed', 'success'],
    ['failed', 'Run failed', 'error'],
    ['aborted', 'Run aborted', 'warning'],
  ] satisfies Array<[RunStatus, string, string]>)('falls back for %s runs without lifecycle events', (status, headline, severity) => {
    const withLifecycle = deriveRunViewModel(detail({
      status,
      lifecycle: {
        phase: status === 'running' ? 'running-tests' : status,
        headline,
        updatedAt: '2026-05-08T00:00:03.000Z',
      },
    }))
    const vm = deriveRunViewModel(detail({ status }))

    expect(vm.headline).toBe(headline)
    expect(vm.recoveryTimeline).toEqual([])
    expect(withLifecycle.headline).toBe(headline)
    expect(withLifecycle.recoveryTimeline).toEqual([
      {
        phase: status === 'running' ? 'running-tests' : status,
        headline,
        updatedAt: '2026-05-08T00:00:03.000Z',
        severity,
      },
    ])
  })

  it('derives actions and alerts from list entries without detail-only data', () => {
    const entry: RunIndexEntry = {
      runId: 'run-2',
      feature: 'checkout',
      startedAt: '2026-05-08T00:00:00.000Z',
      status: 'passed',
    }

    const vm = deriveRunViewModel(entry)

    expect(vm.headline).toBe('Run passed')
    expect(vm.primaryAlert).toEqual({ tone: 'success', message: 'Run passed.' })
    expect(vm.actions.delete.enabled).toBe(true)
    expect(vm.actions.restartHeal.reason).toBe('Restart Heal is available after a failed or aborted run.')
    expect(vm.recoveryTimeline).toEqual([])
  })

  it('uses an aborted fallback for missing run data', () => {
    const vm = deriveRunViewModel(undefined)

    expect(vm.displayStatus).toBe('aborted')
    expect(vm.headline).toBe('Run aborted')
    expect(vm.primaryAlert).toEqual({ tone: 'warning', message: 'Run aborted before completion.' })
    expect(vm.actions.restartHeal.enabled).toBe(true)
  })

  it('describes why active-only actions are unavailable on terminal runs', () => {
    const vm = deriveRunViewModel(detail({ status: 'failed' }))

    expect(vm.primaryAlert).toEqual({ tone: 'error', message: 'Run finished with failing tests.' })
    expect(vm.actions.pauseHeal.reason).toBe('Pause & Heal is available only while tests are running.')
    expect(vm.actions.stop.reason).toBe('Stop is available only while tests are running.')
    expect(vm.actions.cancelHeal.reason).toBe('Cancel Heal is available only while an agent is healing.')
  })
})
