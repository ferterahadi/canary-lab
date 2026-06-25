// Shared low-level reconnecting WebSocket. Every live socket in the web app
// (the workspace event bus, the per-task agent/eval/pane streams) layers its
// own frame parsing on top of this single core: resolve the impl + base URL,
// open, reconnect on an unexpected close, and stop on caller-signalled
// completion (`markDone`) or an explicit `close`.
//
// Before this there were four near-identical copies of the open/reconnect/close
// scaffold — and the workspace bus shipped WITHOUT reconnect, so any dropped
// socket (e.g. the server restart in the canary-apply rebuild cycle) silently
// froze every live UI update until a manual page refresh. One home now; see
// cl_reuse-shared-logic.

export interface ReconnectingSocketOptions {
  url: string
  // Constructor injection for tests; falls back to globalThis.WebSocket.
  WebSocketImpl?: typeof WebSocket
  // Raw string payloads only — non-string frames are dropped before this fires.
  onMessage: (data: string) => void
  onOpen?: () => void
  // Low-level transport error (ws.onerror). Frame-level errors stay the caller's.
  onError?: (message: string) => void
  // Reconnect attempts after an unexpected close. Default 1 (per-task streams).
  // Pass Infinity for an always-on stream that must survive server restarts.
  maxReconnects?: number
  // Delay before each reconnect. Default 0 = synchronous (preserves the
  // per-task socket behaviour and their existing tests). Use a positive delay
  // for an always-on stream so an unreachable server isn't hammered.
  reconnectDelayMs?: number
}

export interface ReconnectingSocket {
  // Stop for good: no further reconnects, close the live socket if it is open.
  close(): void
  // The stream reached a natural end (an exit/done frame). Stop reconnecting
  // but leave the socket to close on its own.
  markDone(): void
  // Send a frame; no-ops unless the socket is OPEN and not closed. Never throws.
  send(payload: string): void
}

export function defaultWsBase(): string {
  if (typeof location === 'undefined') return 'ws://127.0.0.1:7421'
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}`
}

export function connectReconnectingSocket(opts: ReconnectingSocketOptions): ReconnectingSocket {
  const WSImpl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  if (!WSImpl) throw new Error('WebSocket implementation not available')
  const maxReconnects = opts.maxReconnects ?? 1
  const reconnectDelayMs = opts.reconnectDelayMs ?? 0

  let closed = false
  let done = false
  let reconnectsLeft = maxReconnects
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const open = (): void => {
    const ws = new WSImpl(opts.url)
    socket = ws
    ws.onmessage = (ev: MessageEvent): void => {
      if (typeof ev.data === 'string') opts.onMessage(ev.data)
    }
    ws.onopen = (): void => { opts.onOpen?.() }
    ws.onclose = (): void => {
      socket = null
      if (closed || done) return
      if (reconnectsLeft > 0) {
        reconnectsLeft -= 1
        if (reconnectDelayMs > 0) {
          reconnectTimer = setTimeout(() => { reconnectTimer = null; open() }, reconnectDelayMs)
        } else {
          open()
        }
      }
    }
    ws.onerror = (): void => { opts.onError?.('socket error') }
  }

  open()

  return {
    close(): void {
      closed = true
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (socket && socket.readyState <= 1) {
        try { socket.close() } catch { /* already gone */ }
      }
      socket = null
    },
    markDone(): void { done = true },
    send(payload: string): void {
      if (closed || !socket || socket.readyState !== 1) return
      try { socket.send(payload) } catch { /* socket may have just closed */ }
    },
  }
}
