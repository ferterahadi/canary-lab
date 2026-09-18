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
  severity?: 'neutral' | 'warning' | 'danger'
  target?: NotificationTarget
  /** Whether this unresolved unread item may interrupt with a sticky toast.
   * Absent legacy records remain inbox-only. */
  toast?: boolean
}

/** An observation of one source, including quiet states. Persisting the quiet
 * transition lets a later failure create a NEW message after an old deletion. */
export interface NotificationSource {
  key: string
  signature: string
  message?: Pick<WorkspaceNotification, 'title' | 'body' | 'target' | 'severity' | 'toast'>
}
