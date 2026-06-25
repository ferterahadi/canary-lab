import type { DraftRecord, EvaluationExportTask } from '../../../shared/api/types'

export type WorkspaceEvent =
  | { type: 'connected' }
  | { type: 'feature-created'; feature: string }
  | { type: 'feature-deleted'; feature: string }
  | { type: 'features-changed' }
  | { type: 'tests-changed'; feature: string }
  | { type: 'envsets-changed'; feature: string }
  | { type: 'coverage-changed'; feature: string }
  | { type: 'verification-config-changed'; feature: string }
  | { type: 'draft-created'; draft: DraftRecord }
  | { type: 'draft-updated'; draft: DraftRecord }
  | { type: 'draft-deleted'; draftId: string }
  | { type: 'evaluation-export-created'; task: EvaluationExportTask }
  | { type: 'evaluation-export-updated'; task: EvaluationExportTask }
  | { type: 'evaluation-export-deleted'; taskId: string }

export interface ConnectWorkspaceEventsOptions {
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
  onEvent: (event: WorkspaceEvent) => void
  onError?: (error: string) => void
}

export interface WorkspaceEventsConnection {
  close(): void
}

export function connectWorkspaceEvents(opts: ConnectWorkspaceEventsOptions): WorkspaceEventsConnection {
  const WSImpl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  if (!WSImpl) throw new Error('WebSocket implementation not available')
  const base = opts.wsBase ?? defaultWsBase()
  const socket = new WSImpl(`${base}/ws/workspace`)
  socket.onmessage = (ev) => {
    try {
      opts.onEvent(JSON.parse(typeof ev.data === 'string' ? ev.data : '') as WorkspaceEvent)
    } catch {
      // Ignore malformed frames; the next valid workspace event can still recover state.
    }
  }
  socket.onerror = () => opts.onError?.('unknown error')
  return {
    close: () => {
      try { socket.close() } catch { /* already closed */ }
    },
  }
}

function defaultWsBase(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:7421'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}`
}
