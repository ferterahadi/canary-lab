// Thin wrapper around the per-run pane WebSocket. Replay-on-connect is handled
// server-side by PaneBroker; we just forward chunks to the consumer.
//
// Reconnect policy: on unexpected close (no exit message received), attempt one
// reconnect. After that, give up — the caller can re-invoke connectPane(). The
// open/reconnect/close scaffold + send guards live in connectReconnectingSocket.

import { connectReconnectingSocket, defaultWsBase } from '../../../shared/api/reconnecting-socket'

export interface PaneSocketMessage {
  type: 'data' | 'exit' | 'error' | 'reset'
  chunk?: string
  code?: number
  error?: string
}

export interface ConnectPaneOptions {
  runId: string
  paneId: string
  onData: (chunk: string) => void
  onExit?: (code: number) => void
  onError?: (err: string) => void
  // Fires when the server signals a pane reset (e.g. Restart Heal kicked
  // off a fresh orchestrator). The agent pane uses this to `term.clear()`
  // so the new REPL streams into an empty xterm.
  onReset?: () => void
  // Fires once the WebSocket transitions to OPEN. The agent pane uses this
  // to send its initial cols/rows so the REPL renders at the correct width.
  onOpen?: () => void
  // Optional override — defaults to `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`.
  // Tests inject a deterministic base.
  wsBase?: string
  // Constructor injection for tests.
  WebSocketImpl?: typeof WebSocket
  // Maximum reconnect attempts (default: 1).
  maxReconnects?: number
}

export interface PaneConnection {
  close(): void
  // Forward raw keystrokes from xterm.js to the server-side pty stdin. Used
  // by the agent pane to type directly into a long-lived REPL (claude/codex).
  // No-ops until the socket is OPEN; never throws.
  sendInput(chunk: string): void
  // Forward terminal dimensions (xterm.js cols/rows) to the server-side pty.
  // Without this, the agent TUI renders at the pty's spawn-time defaults
  // (120×30) regardless of the actual pane width — status bars and
  // box-drawing wrap mid-word. No-ops until the socket is OPEN.
  sendResize(cols: number, rows: number): void
}

export function connectPane(opts: ConnectPaneOptions): PaneConnection {
  const base = opts.wsBase ?? defaultWsBase()
  const url = `${base}/ws/run/${encodeURIComponent(opts.runId)}/pane/${encodeURIComponent(opts.paneId)}`

  const conn = connectReconnectingSocket({
    url,
    WebSocketImpl: opts.WebSocketImpl,
    maxReconnects: opts.maxReconnects,
    onOpen: opts.onOpen,
    onError: opts.onError,
    onMessage: (data) => {
      let msg: PaneSocketMessage
      try {
        msg = JSON.parse(data) as PaneSocketMessage
      } catch {
        return
      }
      if (msg.type === 'data' && typeof msg.chunk === 'string') {
        opts.onData(msg.chunk)
      } else if (msg.type === 'exit' && typeof msg.code === 'number') {
        conn.markDone()
        opts.onExit?.(msg.code)
      } else if (msg.type === 'reset') {
        opts.onReset?.()
      } else if (msg.type === 'error') {
        opts.onError?.(msg.error ?? 'unknown error')
      }
    },
  })

  return {
    close(): void {
      conn.close()
    },
    sendInput(chunk: string): void {
      conn.send(JSON.stringify({ type: 'pty-input', chunk }))
    },
    sendResize(cols: number, rows: number): void {
      // Sanitize at the edge — node-pty refuses NaN / 0 / negatives, and
      // letting them flow through would just be a wasted round-trip.
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
      if (cols < 1 || rows < 1) return
      conn.send(JSON.stringify({ type: 'pty-resize', cols, rows }))
    },
  }
}
