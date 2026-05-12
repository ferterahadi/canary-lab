import type {
  DisplayStatus,
  RunDetail,
  RunIndexEntry,
  RunLifecycleEvent,
  RunStatus,
  TransientAction,
} from '../api/types'
import {
  deriveDisplayStatus,
  deriveRunActionAvailability,
  isTerminalRunStatus,
} from '../../../../shared/run-state'
import type { RunActionAvailability } from '../../../../shared/run-state'

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
    actions: deriveRunActionAvailability(status, transient),
    recoveryTimeline: events.length > 0 ? events : lifecycle ? [{ ...lifecycle, severity: severityForStatus(status) }] : [],
  }
}

function isRunDetail(input: RunDetail | RunIndexEntry | null | undefined): input is RunDetail {
  return Boolean(input && 'manifest' in input)
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
  if (isTerminalRunStatus(status)) return 'warning'
  return 'info'
}
