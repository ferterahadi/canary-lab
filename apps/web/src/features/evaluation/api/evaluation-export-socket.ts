import { dispatchOutputFrame } from '@/shared/api/output-frame'
import { connectReconnectingSocket, defaultWsBase } from '@/shared/api/reconnecting-socket'
import { displayError } from '@/shared/api/error-message'

export interface EvaluationExportSocketMessage {
  type: 'data' | 'exit' | 'error'
  chunk?: string
  code?: number
  error?: string
}

export interface ConnectEvaluationExportOptions {
  taskId: string
  onData: (chunk: string) => void
  onExit?: (code: number) => void
  onError?: (err: string) => void
  onUnavailable?: (err: string) => void
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
  maxReconnects?: number
}

export interface EvaluationExportConnection {
  close(): void
}

export function connectEvaluationExport(opts: ConnectEvaluationExportOptions): EvaluationExportConnection {
  const base = opts.wsBase ?? defaultWsBase()
  const conn = connectReconnectingSocket({
    url: `${base}/ws/evaluation-exports/${encodeURIComponent(opts.taskId)}`,
    WebSocketImpl: opts.WebSocketImpl,
    maxReconnects: opts.maxReconnects,
    onError: opts.onError,
    onSetupError: opts.onUnavailable
      ? (error) => opts.onUnavailable?.(displayError(error))
      : undefined,
    onMessage: (data) => dispatchOutputFrame(data, opts, () => conn.markDone()),
  })
  return { close: () => conn.close() }
}
