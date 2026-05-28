export type RunStatus = 'running' | 'passed' | 'failed' | 'healing' | 'aborted'
export type ServiceStatus = 'starting' | 'ready' | 'timeout' | 'stopped'

export type RunLifecyclePhase =
  | 'starting-services'
  | 'running-tests'
  | 'pausing-for-heal'
  | 'agent-healing'
  | 'waiting-for-signal'
  | 'applying-signal'
  | 'restarting-services'
  | 'rerunning-tests'
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'passed'

export type RunLifecycleSeverity = 'info' | 'success' | 'warning' | 'error'
export type RunLifecycleSignalStatus = 'accepted' | 'ignored'
export type HealSignalKind = 'restart' | 'rerun' | 'heal'
export type HealSignalIgnoredReason = 'not-waiting-for-signal' | 'signal-already-pending'

export interface RunLifecycleSignal {
  kind: HealSignalKind
  status: RunLifecycleSignalStatus
  reason?: string
}

export interface RunLifecycleRestartPlan {
  restarted: string[]
  kept: string[]
  startedBecauseMissing?: string[]
  noMatch?: boolean
}

export interface RunLifecycleTargetedRerun {
  selected: number
  total: number
  mode: 'failed-and-pending' | 'failed-only' | 'full-suite' | 'none'
  reason: string
}

export interface RunLifecycleAbortReason {
  reason: string
  service?: string
}

export interface RunLifecycleSnapshot {
  phase: RunLifecyclePhase
  headline: string
  detail?: string
  updatedAt: string
  activeCycle?: number
  lastSignal?: RunLifecycleSignal
  restartPlan?: RunLifecycleRestartPlan
  targetedRerun?: RunLifecycleTargetedRerun
  abortReason?: RunLifecycleAbortReason
}

export interface RunLifecycleEvent extends RunLifecycleSnapshot {
  id?: string
  severity?: RunLifecycleSeverity
}

export type TransientAction = 'aborting' | 'deleting' | 'cancelling-heal' | 'pausing'
export type DisplayStatus = RunStatus | TransientAction

export interface RunActionAvailability {
  enabled: boolean
  reason?: string
}

export interface RunActionAvailabilitySet {
  pauseHeal: RunActionAvailability
  stop: RunActionAvailability
  cancelHeal: RunActionAvailability
  delete: RunActionAvailability
  restartHeal: RunActionAvailability
}

export const TERMINAL_RUN_STATUSES = ['passed', 'failed', 'aborted'] as const
export const ACTIVE_RUN_STATUSES = ['running', 'healing'] as const

export type TerminalRunStatus = typeof TERMINAL_RUN_STATUSES[number]
export type ActiveRunStatus = typeof ACTIVE_RUN_STATUSES[number]

export const HEARTBEAT_STALE_MS = 10 * 60 * 1000

export function isTerminalRunStatus(status: string | null | undefined): status is TerminalRunStatus {
  return status === 'passed' || status === 'failed' || status === 'aborted'
}

export function isActiveRunStatus(status: string | null | undefined): status is ActiveRunStatus {
  return status === 'running' || status === 'healing'
}

export function isRestartableRunStatus(status: string | null | undefined): status is 'failed' | 'aborted' {
  return status === 'failed' || status === 'aborted'
}

export function isStaleHeartbeat(
  heartbeatAt: string | null | undefined,
  nowMs: number = Date.now(),
  staleMs: number = HEARTBEAT_STALE_MS,
): boolean {
  if (!heartbeatAt) return false
  const heartbeatMs = new Date(heartbeatAt).getTime()
  return Number.isFinite(heartbeatMs) && nowMs - heartbeatMs > staleMs
}

export function deriveDisplayStatus(
  status: RunStatus,
  transient: TransientAction | null,
): DisplayStatus {
  return transient ?? status
}

export function deriveRunActionAvailability(
  status: RunStatus,
  transient: TransientAction | null = null,
): RunActionAvailabilitySet {
  return {
    pauseHeal: availability(status === 'running' && !transient, disabledReason('pauseHeal', status, transient)),
    stop: availability(status === 'running' && !transient, disabledReason('stop', status, transient)),
    cancelHeal: availability(status === 'healing' && !transient, disabledReason('cancelHeal', status, transient)),
    delete: availability(isTerminalRunStatus(status) && !transient, disabledReason('delete', status, transient)),
    restartHeal: availability(isRestartableRunStatus(status) && !transient, disabledReason('restartHeal', status, transient)),
  }
}

export function reduceRunLifecycleSnapshot(
  previous: RunLifecycleSnapshot | undefined,
  event: RunLifecycleEvent,
): RunLifecycleSnapshot {
  const { id: _id, severity: _severity, ...snapshot } = event
  if (snapshot.targetedRerun || !previous?.targetedRerun) return snapshot
  return { ...snapshot, targetedRerun: previous.targetedRerun }
}

type RunLifecycleEventOptions =
  Partial<Omit<RunLifecycleEvent, 'phase' | 'headline' | 'updatedAt'>>
  & { updatedAt?: string }

export function createRunLifecycleEvent(
  phase: RunLifecyclePhase,
  headline: string,
  opts: RunLifecycleEventOptions = {},
): RunLifecycleEvent {
  return {
    phase,
    headline,
    updatedAt: opts.updatedAt ?? new Date().toISOString(),
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.activeCycle !== undefined ? { activeCycle: opts.activeCycle } : {}),
    ...(opts.lastSignal ? { lastSignal: opts.lastSignal } : {}),
    ...(opts.restartPlan ? { restartPlan: opts.restartPlan } : {}),
    ...(opts.targetedRerun ? { targetedRerun: opts.targetedRerun } : {}),
    ...(opts.abortReason ? { abortReason: opts.abortReason } : {}),
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.severity ? { severity: opts.severity } : {}),
  }
}

export interface HealSignal {
  kind: HealSignalKind
  body: Record<string, unknown>
}

export type HealSignalGateResult =
  | { accepted: true; signal: HealSignal }
  | { accepted: false; kind: HealSignalKind; reason: HealSignalIgnoredReason; pendingKind?: HealSignalKind }

export class HealSignalGate {
  private waiting = false
  private pending: HealSignal | null = null

  beginWaiting(): void {
    this.waiting = true
  }

  endWaiting(): void {
    this.waiting = false
  }

  observe(kind: HealSignalKind, body: Record<string, unknown>): HealSignalGateResult {
    if (!this.waiting) {
      return { accepted: false, kind, reason: 'not-waiting-for-signal' }
    }
    if (this.pending) {
      return {
        accepted: false,
        kind,
        reason: 'signal-already-pending',
        pendingKind: this.pending.kind,
      }
    }
    const signal = { kind, body }
    this.pending = signal
    return { accepted: true, signal }
  }

  consume(): HealSignal | null {
    const signal = this.pending
    this.pending = null
    return signal
  }
}

function availability(enabled: boolean, reason?: string): RunActionAvailability {
  return enabled ? { enabled: true } : { enabled: false, reason }
}

function disabledReason(
  action: keyof RunActionAvailabilitySet,
  status: RunStatus,
  transient: TransientAction | null,
): string | undefined {
  if (transient) return `Action unavailable while ${transient.replace(/-/g, ' ')} is in progress.`
  if (action === 'pauseHeal') return status === 'running' ? undefined : 'Pause & Heal is available only while tests are running.'
  if (action === 'stop') return status === 'running' ? undefined : 'Stop is available only while tests are running.'
  if (action === 'cancelHeal') return status === 'healing' ? undefined : 'Cancel Heal is available only while an agent is healing.'
  if (action === 'delete') return isTerminalRunStatus(status) ? undefined : 'Delete is available after the run finishes.'
  if (action === 'restartHeal') return isRestartableRunStatus(status) ? undefined : 'Restart Heal is available after a failed or aborted run.'
  return undefined
}
