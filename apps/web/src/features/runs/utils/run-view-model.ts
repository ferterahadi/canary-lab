import type {
  DisplayStatus,
  ExecutionType,
  RunDetail,
  RunIndexEntry,
  RunLifecycleEvent,
  RunStatus,
  TransientAction,
} from '../../../api/types'
import {
  deriveDisplayStatus,
  deriveRunActionAvailability,
  isTerminalRunStatus,
} from '../../../../../../shared/run-state'
import type { RunActionAvailability } from '../../../../../../shared/run-state'

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
  const executionType = manifest?.executionType ?? 'run'
  const lifecycle = detail?.manifest.lifecycle
  const events = detail?.lifecycleEvents ?? []
  const displayStatus = deriveDisplayStatus(status, transient)
  const headline = transientHeadline(transient, executionType) ?? lifecycle?.headline ?? fallbackHeadline(status, executionType)
  const subtext = lifecycle?.detail
  const alert = primaryAlert(status, lifecycle?.abortReason?.service, executionType)

  return {
    displayStatus,
    headline,
    ...(subtext ? { subtext } : {}),
    ...(alert ? { primaryAlert: alert } : {}),
    actions: executionType === 'verify'
      ? verifyActionAvailability(status, transient)
      : executionType === 'boot'
        ? bootActionAvailability(status, transient)
        : deriveRunActionAvailability(status, transient),
    recoveryTimeline: events.length > 0 ? events : lifecycle ? [{ ...lifecycle, severity: severityForStatus(status) }] : [],
  }
}

function verifyActionAvailability(
  status: RunStatus,
  transient: TransientAction | null,
): RunViewModel['actions'] {
  const base = deriveRunActionAvailability(status, transient)
  return {
    ...base,
    pauseHeal: { enabled: false, reason: 'Verify is observational and does not start healing.' },
    cancelHeal: { enabled: false, reason: 'Verify does not start heal cycles.' },
    restartHeal: { enabled: false, reason: 'Verify results are not healed; start another Verify execution instead.' },
  }
}

// A boot-only session boots services and holds them — it never runs tests or
// heals. Only Stop (tear down + revert env) and, once stopped, Delete apply.
function bootActionAvailability(
  status: RunStatus,
  transient: TransientAction | null,
): RunViewModel['actions'] {
  const base = deriveRunActionAvailability(status, transient)
  const reason = 'Boot-only sessions do not run tests or heal.'
  return {
    ...base,
    pauseHeal: { enabled: false, reason },
    cancelHeal: { enabled: false, reason },
    restartHeal: { enabled: false, reason },
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
