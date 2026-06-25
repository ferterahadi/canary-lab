import { connectReconnectingSocket, defaultWsBase } from '../../../shared/api/reconnecting-socket'

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
    onMessage: (data) => {
      let msg: EvaluationExportSocketMessage
      try {
        msg = JSON.parse(data) as EvaluationExportSocketMessage
      } catch {
        return
      }
      if (msg.type === 'data' && typeof msg.chunk === 'string') {
        opts.onData(msg.chunk)
      } else if (msg.type === 'exit' && typeof msg.code === 'number') {
        conn.markDone()
        opts.onExit?.(msg.code)
      } else if (msg.type === 'error') {
        opts.onError?.(msg.error ?? 'unknown error')
      }
    },
  })
  return { close: () => conn.close() }
}
