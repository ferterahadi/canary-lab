import type { ExecutionType } from '@shared/verification'
import type { RunDetail } from '@shared/run-detail'
import type { RunIndexEntry } from '@shared/run-index'
import {
  deriveDisplayStatus,
  deriveRunActionAvailability,
  isTerminalRunStatus,
  type DisplayStatus,
  type RunLifecycleEvent,
  type RunStatus,
  type TransientAction,
} from '@shared/run-state'
import { runWaitingState, type RunWaitingState } from './run-waiting-state'
import type { RunActionAvailabilitySet } from '@shared/run-state'

export interface RunViewModel {
  waiting?: RunWaitingState
  displayStatus: DisplayStatus
  headline: string
  subtext?: string
  primaryAlert?: { tone: 'info' | 'success' | 'warning' | 'error'; message: string }
  actions: RunActionAvailabilitySet
  recoveryTimeline: RunLifecycleEvent[]
}

export function deriveRunViewModel(
  input: RunDetail | RunIndexEntry | null | undefined,
  transient: TransientAction | null = null,
): RunViewModel {
  const detail = isRunDetail(input) ? input : null
  const manifest = isRunDetail(input) ? input.manifest : (input ?? undefined)
  const status = manifest?.status ?? 'aborted'
  const executionType = manifest?.executionType ?? 'run'
  const lifecycle = detail?.manifest.lifecycle
  const newRunRequired = detail?.newRunRequired === true || detail?.manifest.healEnd?.reason === 'new-run-required'
    || (!detail && input?.newRunRequired === true)
  const events = detail?.lifecycleEvents ?? []
  const displayStatus = deriveDisplayStatus(status, transient)
  const waiting = transient ? undefined : runWaitingState(input)
  const headline = newRunRequired ? 'New run required to verify repair' : (waiting?.kind === 'queued' ? undefined : waiting?.label) ?? transientHeadline(transient, executionType) ?? lifecycle?.headline ?? fallbackHeadline(status, executionType)
  const subtext = newRunRequired ? detail?.manifest.healEnd?.message : waiting?.detail ?? lifecycle?.detail
  const alert = newRunRequired
    ? { tone: 'warning' as const, message: detail?.manifest.healEnd?.message ?? 'This run cannot verify another attempt. Start a fresh run after approval.' }
    : primaryAlert(status, lifecycle?.abortReason?.service, executionType)

  return {
    displayStatus,
    ...(waiting ? { waiting } : {}),
    headline,
    ...(subtext ? { subtext } : {}),
    ...(alert ? { primaryAlert: alert } : {}),
    actions: deriveRunActionAvailability(status, transient, { executionType, newRunRequired }),
    recoveryTimeline: events.length > 0 ? events : lifecycle ? [{ ...lifecycle, severity: severityForStatus(status) }] : [],
  }
}

function isRunDetail(input: RunDetail | RunIndexEntry | null | undefined): input is RunDetail {
  return Boolean(input && 'manifest' in input)
}

function fallbackHeadline(status: RunStatus, executionType: ExecutionType = 'run'): string {
  if (executionType === 'boot') {
    switch (status) {
      case 'running': return 'Services ready'
      case 'queued': return 'Queued — services will boot when capacity frees'
      case 'aborted': return 'Services stopped'
      default: return 'Boot-only session'
    }
  }
  switch (status) {
    case 'running': return 'Running tests'
    case 'healing': return 'Healing'
    case 'passed': return 'Run passed'
    case 'failed': return 'Run failed'
    case 'aborted': return 'Run aborted'
    case 'queued': return 'Queued — will start when capacity frees'
  }
}

function transientHeadline(transient: TransientAction | null, executionType: ExecutionType = 'run'): string | undefined {
  if (!transient) return undefined
  if (transient === 'aborting') return executionType === 'boot' ? 'Stopping services' : 'Stopping run'
  if (transient === 'deleting') return 'Deleting run'
  if (transient === 'cancelling-heal') return 'Cancelling heal'
  if (transient === 'pausing') return 'Pausing for heal'
}

function primaryAlert(status: RunStatus, service?: string, executionType: ExecutionType = 'run'): RunViewModel['primaryAlert'] | null {
  if (executionType === 'boot') {
    if (status === 'running') return { tone: 'info', message: 'Services are up and held. Stop the run to tear them down and revert the envset.' }
    if (status === 'aborted') {
      return service
        ? { tone: 'warning', message: `Boot stopped because ${service} failed health checks. Envset reverted.` }
        : { tone: 'info', message: 'Services stopped. Envset reverted.' }
    }
    return null
  }
  const label = executionType === 'verify' ? 'Verify' : 'Run'
  if (status === 'aborted') {
    return {
      tone: 'warning',
      message: service ? `${label} aborted because ${service} failed health checks.` : `${label} aborted before completion.`,
    }
  }
  if (status === 'failed') return { tone: 'error', message: executionType === 'verify' ? 'Verify found deployment failures. No healing was started.' : 'Run finished with failing tests.' }
  if (status === 'passed') return { tone: 'success', message: `${label} passed.` }
  return null
}

function severityForStatus(status: RunStatus): RunLifecycleEvent['severity'] {
  if (status === 'passed') return 'success'
  if (status === 'failed') return 'error'
  if (isTerminalRunStatus(status)) return 'warning'
  return 'info'
}
