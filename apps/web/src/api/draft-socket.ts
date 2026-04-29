// WebSocket wrapper for the wizard draft agent stream. Mirrors `pane-socket`
// but keyed on draft id and pointed at `/ws/draft/:draftId/agent`. The
// server-side broker replays buffered chunks on connect, so reconnect is the
// same one-shot policy: try once after an unexpected close, then give up.

export interface DraftSocketMessage {
  type: 'data' | 'exit' | 'error'
  chunk?: string
  code?: number
  error?: string
}

export interface ConnectDraftAgentOptions {
  draftId: string
  onData: (chunk: string) => void
  onExit?: (code: number) => void
  onError?: (err: string) => void
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
  maxReconnects?: number
}

export interface DraftAgentConnection {
  close(): void
}

const defaultWsBase = (): string => {
  if (typeof location === 'undefined') return 'ws://127.0.0.1:7421'
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}`
}

export function connectDraftAgent(opts: ConnectDraftAgentOptions): DraftAgentConnection {
  const WSImpl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  if (!WSImpl) {
    throw new Error('WebSocket implementation not available')
  }
  const base = opts.wsBase ?? defaultWsBase()
  const url = `${base}/ws/draft/${encodeURIComponent(opts.draftId)}/agent`
  const maxReconnects = opts.maxReconnects ?? 1

  let closed = false
  let exited = false
  let reconnectsLeft = maxReconnects
  let socket: WebSocket | null = null

  const open = (): void => {
    const ws = new WSImpl(url)
    socket = ws
    ws.onmessage = (ev: MessageEvent): void => {
      let msg: DraftSocketMessage
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as DraftSocketMessage
      } catch {
        return
      }
      if (msg.type === 'data' && typeof msg.chunk === 'string') {
        opts.onData(msg.chunk)
      } else if (msg.type === 'exit' && typeof msg.code === 'number') {
        exited = true
        opts.onExit?.(msg.code)
      } else if (msg.type === 'error') {
        opts.onError?.(msg.error ?? 'unknown error')
      }
    }
    ws.onclose = (): void => {
      socket = null
      if (closed || exited) return
      if (reconnectsLeft > 0) {
        reconnectsLeft -= 1
        open()
      }
    }
    ws.onerror = (): void => {
      opts.onError?.('socket error')
    }
  }

  open()

  return {
    close(): void {
      closed = true
      if (socket && socket.readyState <= 1) {
        try {
          socket.close()
        } catch {
          /* already gone */
        }
      }
      socket = null
    },
  }
}
