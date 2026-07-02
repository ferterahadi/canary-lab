import { connectReconnectingSocket, defaultWsBase } from '../../../shared/api/reconnecting-socket'
import type { DraftRecord, EvaluationExportTask } from '../../../shared/api/types'

export type WorkspaceEvent =
  | { type: 'connected' }
  | { type: 'feature-created'; feature: string }
  | { type: 'feature-deleted'; feature: string }
  | { type: 'features-changed' }
  | { type: 'tests-changed'; feature: string }
  | { type: 'envsets-changed'; feature: string }
  | { type: 'coverage-changed'; feature: string }
  | { type: 'tests-dirty-changed'; feature: string }
  | { type: 'verification-config-changed'; feature: string }
  | { type: 'journal-changed'; runId: string }
  | { type: 'draft-created'; draft: DraftRecord }
  | { type: 'draft-updated'; draft: DraftRecord }
  | { type: 'draft-deleted'; draftId: string }
  | { type: 'evaluation-export-created'; task: EvaluationExportTask }
  | { type: 'evaluation-export-updated'; task: EvaluationExportTask }
  | { type: 'evaluation-export-deleted'; taskId: string }
  | { type: 'version-changed' }

export interface ConnectWorkspaceEventsOptions {
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
  onEvent: (event: WorkspaceEvent) => void
  onError?: (error: string) => void
  // Fired on every RE-open after the first connect. The workspace bus is
  // push-only with no server-side replay, so any event emitted while the
  // socket was down is lost — consumers MUST refetch their state here to close
  // the gap (see cl_live-state-sync). Not fired on the initial connect.
  onReconnect?: () => void
}

export interface WorkspaceEventsConnection {
  close(): void
}

export function connectWorkspaceEvents(opts: ConnectWorkspaceEventsOptions): WorkspaceEventsConnection {
  const base = opts.wsBase ?? defaultWsBase()
  let opened = false
  // The workspace bus is the always-on UI event channel: reconnect forever
  // (with a delay) so a server restart or transient drop never silently
  // freezes live updates until a manual refresh.
  const conn = connectReconnectingSocket({
    url: `${base}/ws/workspace`,
    WebSocketImpl: opts.WebSocketImpl,
    maxReconnects: Infinity,
    reconnectDelayMs: 1500,
    onError: opts.onError ? () => opts.onError?.('unknown error') : undefined,
    onOpen: () => {
      if (opened) opts.onReconnect?.()
      opened = true
    },
    onMessage: (data) => {
      try {
        opts.onEvent(JSON.parse(data) as WorkspaceEvent)
      } catch {
        // Ignore malformed frames; the next valid workspace event can still recover state.
      }
    },
  })
  return { close: () => conn.close() }
}
