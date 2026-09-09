export type NotificationTarget =
  | { kind: 'flight'; flightId: string }
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
}

/** An observation of one source, including quiet states. Persisting the quiet
 * transition lets a later failure create a NEW message after an old deletion. */
export interface NotificationSource {
  key: string
  signature: string
  message?: Pick<WorkspaceNotification, 'title' | 'body' | 'target' | 'severity'>
}
