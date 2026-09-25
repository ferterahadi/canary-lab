export type NotificationTarget =
  | { kind: 'flight'; flightId: string }
  | { kind: 'coverage'; feature: string; stage: import('../coverage/freshness').CoverageRecoveryStage; flightId?: string }
  | { kind: 'feature'; feature: string }
  | { kind: 'test-review'; feature: string; runId?: string }
  | { kind: 'run'; feature: string; runId: string }

export interface WorkspaceNotification {
  id: string
  title: string
  body: string
  createdAt: string
  readAt?: string
  resolvedAt?: string
  /** Last source check failed; the retained issue is not confirmed current. */
  unavailable?: boolean
  severity?: 'neutral' | 'warning' | 'danger'
  target?: NotificationTarget
  /** Whether this unresolved unread item may interrupt with a sticky toast.
   * Absent legacy records remain inbox-only. */
  toast?: boolean
}

export function notificationTarget(item: WorkspaceNotification): NotificationTarget | undefined {
  const target = item.target
  if (item.resolvedAt && target?.kind === 'test-review') {
    return target.runId ? { kind: 'run', feature: target.feature, runId: target.runId } : { kind: 'feature', feature: target.feature }
  }
  return target
}

export interface NotificationActionResult {
  items: WorkspaceNotification[]
  status: 'current' | 'unavailable' | 'missing'
  target?: NotificationTarget
}

/** An observation of one source, including quiet states. Persisting the quiet
 * transition lets a later failure create a NEW message after an old deletion. */
export interface NotificationSource {
  key: string
  signature: string
  message?: Pick<WorkspaceNotification, 'title' | 'body' | 'target' | 'severity' | 'toast'>
}
