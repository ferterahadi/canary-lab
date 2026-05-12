import type {
  DisplayStatus,
  RunDetail,
  RunIndexEntry,
  RunLifecycleEvent,
  RunStatus,
  TransientAction,
} from '../api/types'
import { deriveDisplayStatus } from './run-actions'

export interface RunActionAvailability {
  enabled: boolean
  reason?: string
}

export interface RunViewModel {
  displayStatus: DisplayStatus
  headline: string
  subtext?: string
  primaryAlert?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string }
  actions: {
    pauseHeal: RunActionAvailability
    stop: RunActionAvailability
    cancelHeal: RunActionAvailability
    delete: RunActionAvailability
    restartHeal: RunActionAvailability
  }
  recoveryTimeline: RunLifecycleEvent[]
}

export function deriveRunViewModel(
  input: RunDetail | RunIndexEntry | null | undefined,
  transient: TransientAction | null = null,
): RunViewModel {
  const detail = isRunDetail(input) ? input : null
  const manifest = detail?.manifest ?? input ?? undefined
  const status = manifest?.status ?? 'aborted'
  const lifecycle = detail?.manifest.lifecycle
  const events = detail?.lifecycleEvents ?? []
  const displayStatus = deriveDisplayStatus(status, transient)
  const headline = transientHeadline(transient) ?? lifecycle?.headline ?? fallbackHeadline(status)
  const subtext = lifecycle?.detail
  const alert = primaryAlert(status, lifecycle?.abortReason?.service)

  return {
    displayStatus,
    headline,
    ...(subtext ? { subtext } : {}),
    ...(alert ? { primaryAlert: alert } : {}),
    actions: {
      pauseHeal: availability(status === 'running' && !transient, disabledReason('pauseHeal', status, transient)),
      stop: availability(status === 'running' && !transient, disabledReason('stop', status, transient)),
      cancelHeal: availability(status === 'healing' && !transient, disabledReason('cancelHeal', status, transient)),
      delete: availability(isTerminal(status) && !transient, disabledReason('delete', status, transient)),
      restartHeal: availability((status === 'failed' || status === 'aborted') && !transient, disabledReason('restartHeal', status, transient)),
    },
    recoveryTimeline: events.length > 0 ? events : lifecycle ? [{ ...lifecycle, severity: severityForStatus(status) }] : [],
  }
}

function isRunDetail(input: RunDetail | RunIndexEntry | null | undefined): input is RunDetail {
  return Boolean(input && 'manifest' in input)
}

function availability(enabled: boolean, reason?: string): RunActionAvailability {
  return enabled ? { enabled: true } : { enabled: false, reason }
}

function disabledReason(action: keyof RunViewModel['actions'], status: RunStatus, transient: TransientAction | null): string | undefined {
  if (transient) return `Action unavailable while ${transient.replace(/-/g, ' ')} is in progress.`
  if (action === 'pauseHeal') return status === 'running' ? undefined : 'Pause & Heal is available only while tests are running.'
  if (action === 'stop') return status === 'running' ? undefined : 'Stop is available only while tests are running.'
  if (action === 'cancelHeal') return status === 'healing' ? undefined : 'Cancel Heal is available only while an agent is healing.'
  if (action === 'delete') return isTerminal(status) ? undefined : 'Delete is available after the run finishes.'
  if (action === 'restartHeal') return status === 'failed' || status === 'aborted' ? undefined : 'Restart Heal is available after a failed or aborted run.'
  return undefined
}

function isTerminal(status: RunStatus): boolean {
  return status === 'passed' || status === 'failed' || status === 'aborted'
}

function fallbackHeadline(status: RunStatus): string {
  switch (status) {
    case 'running': return 'Running tests'
    case 'healing': return 'Healing'
    case 'passed': return 'Run passed'
    case 'failed': return 'Run failed'
    case 'aborted': return 'Run aborted'
  }
}

function transientHeadline(transient: TransientAction | null): string | undefined {
  if (!transient) return undefined
  if (transient === 'aborting') return 'Stopping run'
  if (transient === 'deleting') return 'Deleting run'
  if (transient === 'cancelling-heal') return 'Cancelling heal'
  if (transient === 'pausing') return 'Pausing for heal'
}

function primaryAlert(status: RunStatus, service?: string): RunViewModel['primaryAlert'] | null {
  if (status === 'aborted') {
    return {
      tone: 'warning',
      message: service ? `Run aborted because ${service} failed health checks.` : 'Run aborted before completion.',
    }
  }
  if (status === 'failed') return { tone: 'error', message: 'Run finished with failing tests.' }
  if (status === 'passed') return { tone: 'success', message: 'Run passed.' }
  return null
}

function severityForStatus(status: RunStatus): RunLifecycleEvent['severity'] {
  if (status === 'passed') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'aborted') return 'warning'
  return 'info'
}
