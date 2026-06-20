import { describe, expect, it } from 'vitest'
import type { RunDetail, RunIndexEntry, RunStatus, TransientAction } from '../../../shared/api/types'
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

  it('falls back to the run headline for unknown transient action values', () => {
    const vm = deriveRunViewModel(detail({ status: 'failed' }), 'unknown-action' as TransientAction)

    expect(vm.displayStatus).toBe('unknown-action')
    expect(vm.headline).toBe('Run failed')
    expect(Object.values(vm.actions).every((action) => !action.enabled)).toBe(true)
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

  it('renders the cns_fallback_chain Case C recovery shape from one lifecycle timeline', () => {
    const vm = deriveRunViewModel({
      ...detail({
        feature: 'cns_fallback_chain',
        status: 'aborted',
        lifecycle: {
          phase: 'aborted',
          headline: 'Run aborted',
          detail: 'Health failed: ngrok tunnel',
          updatedAt: '2026-05-08T00:00:08.000Z',
          abortReason: { reason: 'service-health-failed', service: 'ngrok tunnel' },
          targetedRerun: {
            selected: 18,
            total: 21,
            mode: 'failed-and-pending',
            reason: 'Rerunning 18 not-yet-passed tests because the suite was paused after 2 passed and 1 failed.',
          },
        },
      }),
      lifecycleEvents: [
        { phase: 'failed', headline: 'Playwright exited with code 1', updatedAt: '2026-05-08T00:00:01.000Z' },
        { phase: 'pausing-for-heal', headline: 'Pause accepted', updatedAt: '2026-05-08T00:00:02.000Z' },
        { phase: 'agent-healing', headline: 'Heal cycle 1 started', updatedAt: '2026-05-08T00:00:03.000Z' },
        {
          phase: 'applying-signal',
          headline: 'Restart signal accepted',
          updatedAt: '2026-05-08T00:00:04.000Z',
          lastSignal: { kind: 'restart', status: 'accepted' },
        },
        {
          phase: 'restarting-services',
          headline: 'Restart plan ready',
          updatedAt: '2026-05-08T00:00:05.000Z',
          restartPlan: {
            restarted: ['mighty-cns gateway stack'],
            kept: ['ngrok tunnel'],
            startedBecauseMissing: ['ngrok tunnel'],
          },
        },
        {
          phase: 'rerunning-tests',
          headline: 'Targeted rerun selected',
          updatedAt: '2026-05-08T00:00:06.000Z',
          targetedRerun: {
            selected: 18,
            total: 21,
            mode: 'failed-and-pending',
            reason: 'Rerunning 18 not-yet-passed tests because the suite was paused after 2 passed and 1 failed.',
          },
        },
        {
          phase: 'aborted',
          headline: 'Health failed: ngrok tunnel',
          updatedAt: '2026-05-08T00:00:07.000Z',
          abortReason: { reason: 'service-health-failed', service: 'ngrok tunnel' },
        },
      ],
    })

    expect(vm.headline).toBe('Run aborted')
    expect(vm.primaryAlert?.message).toBe('Run aborted because ngrok tunnel failed health checks.')
    expect(vm.actions.restartHeal.enabled).toBe(true)
    expect(vm.recoveryTimeline.map((event) => event.headline)).toEqual([
      'Playwright exited with code 1',
      'Pause accepted',
      'Heal cycle 1 started',
      'Restart signal accepted',
      'Restart plan ready',
      'Targeted rerun selected',
      'Health failed: ngrok tunnel',
    ])
    expect(vm.recoveryTimeline.find((event) => event.targetedRerun)?.targetedRerun?.selected).toBe(18)
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
    expect(vm.actions.stop.reason).toBe('Stop is available only while a run is queued or its tests are running.')
    expect(vm.actions.cancelHeal.reason).toBe('Cancel Heal is available only while an agent is healing.')
  })

  it('disables heal-only actions for verification runs', () => {
    const vm = deriveRunViewModel(detail({ executionType: 'verify', status: 'failed' }))

    expect(vm.actions.pauseHeal).toEqual({
      enabled: false,
      reason: 'Verify is observational and does not start healing.',
    })
    expect(vm.actions.cancelHeal).toEqual({
      enabled: false,
      reason: 'Verify does not start heal cycles.',
    })
    expect(vm.actions.restartHeal).toEqual({
      enabled: false,
      reason: 'Verify results are not healed; start another Verify execution instead.',
    })
    expect(vm.actions.delete.enabled).toBe(true)
  })

  it('holds a boot session: only Stop is offered, with a teal-friendly headline + alert', () => {
    const vm = deriveRunViewModel(detail({ executionType: 'boot', status: 'running' }))

    // Held boot session: Stop is the only live action; heal actions are gated.
    expect(vm.actions.stop.enabled).toBe(true)
    expect(vm.actions.pauseHeal.enabled).toBe(false)
    expect(vm.actions.pauseHeal.reason).toContain('Boot-only')
    expect(vm.actions.cancelHeal.enabled).toBe(false)
    expect(vm.actions.restartHeal.enabled).toBe(false)
    // No lifecycle in this fixture → boot fallback headline + info alert.
    expect(vm.headline).toBe('Services ready')
    expect(vm.primaryAlert).toEqual({
      tone: 'info',
      message: 'Services are up and held. Stop the run to tear them down and revert the envset.',
    })
  })

  it('reassures that the envset reverted when a boot session is stopped', () => {
    const vm = deriveRunViewModel(detail({ executionType: 'boot', status: 'aborted' }))
    expect(vm.headline).toBe('Services stopped')
    expect(vm.primaryAlert).toEqual({ tone: 'info', message: 'Services stopped. Envset reverted.' })
    expect(vm.actions.restartHeal.enabled).toBe(false)
    expect(vm.actions.delete.enabled).toBe(true)
  })

  it('relabels the stop transient as "Stopping services" for a boot run', () => {
    const vm = deriveRunViewModel(detail({ executionType: 'boot', status: 'running' }), 'aborting')
    expect(vm.headline).toBe('Stopping services')
  })

  it('labels a queued boot run and shows no alert', () => {
    const vm = deriveRunViewModel(detail({ executionType: 'boot', status: 'queued' }))
    expect(vm.headline).toBe('Queued — services will boot when capacity frees')
    expect(vm.primaryAlert).toBeUndefined()
  })

  it('falls back to a generic boot headline for unexpected statuses, with no alert', () => {
    // A boot session never passes/fails (no tests), but the headline + alert
    // stay defined defensively for any status.
    const vm = deriveRunViewModel(detail({ executionType: 'boot', status: 'passed' }))
    expect(vm.headline).toBe('Boot-only session')
    expect(vm.primaryAlert).toBeUndefined()
  })

  it('explains a health-failed boot abort and confirms the envset reverted', () => {
    const vm = deriveRunViewModel(detail({
      executionType: 'boot',
      status: 'aborted',
      lifecycle: {
        phase: 'aborted',
        headline: 'Services stopped — envset reverted',
        updatedAt: '2026-05-08T00:00:02.000Z',
        abortReason: { reason: 'service-health-failed', service: 'api' },
      },
    }))
    expect(vm.primaryAlert).toEqual({
      tone: 'warning',
      message: 'Boot stopped because api failed health checks. Envset reverted.',
    })
  })
})
