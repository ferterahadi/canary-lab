import type { ClientKind } from '@shared/run-mode'

export interface AuditEntry {
  ts: string
  sessionId: string | null
  clientKind: ClientKind | null
  action: string
  args?: Record<string, unknown>
  result?: Record<string, unknown>
}

export interface AuditList {
  entries: AuditEntry[]
}
