// Thin wrapper around the per-run pane WebSocket. Replay-on-connect is handled
// server-side by PaneBroker; we just forward chunks to the consumer.
//
// Reconnect policy: on unexpected close (no exit message received), attempt one
// reconnect. After that, give up — the caller can re-invoke connectPane().

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

const defaultWsBase = (): string => {
  if (typeof location === 'undefined') return 'ws://127.0.0.1:7421'
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}`
}

export function connectPane(opts: ConnectPaneOptions): PaneConnection {
  const WSImpl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  if (!WSImpl) {
    throw new Error('WebSocket implementation not available')
  }
  const base = opts.wsBase ?? defaultWsBase()
  const url = `${base}/ws/run/${encodeURIComponent(opts.runId)}/pane/${encodeURIComponent(opts.paneId)}`
  const maxReconnects = opts.maxReconnects ?? 1

  let closed = false
  let exited = false
  let reconnectsLeft = maxReconnects
  let socket: WebSocket | null = null

  const open = (): void => {
    const ws = new WSImpl(url)
    socket = ws
    ws.onmessage = (ev: MessageEvent): void => {
      let msg: PaneSocketMessage
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as PaneSocketMessage
      } catch {
        return
      }
      if (msg.type === 'data' && typeof msg.chunk === 'string') {
        opts.onData(msg.chunk)
      } else if (msg.type === 'exit' && typeof msg.code === 'number') {
        exited = true
        opts.onExit?.(msg.code)
      } else if (msg.type === 'reset') {
        opts.onReset?.()
      } else if (msg.type === 'error') {
        opts.onError?.(msg.error ?? 'unknown error')
      }
    }
    ws.onopen = (): void => {
      opts.onOpen?.()
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
    sendInput(chunk: string): void {
      if (closed || !socket || socket.readyState !== 1) return
      try {
        socket.send(JSON.stringify({ type: 'pty-input', chunk }))
      } catch {
        /* socket may have just closed */
      }
    },
    sendResize(cols: number, rows: number): void {
      if (closed || !socket || socket.readyState !== 1) return
      // Sanitize at the edge — node-pty refuses NaN / 0 / negatives, and
      // letting them flow through would just be a wasted round-trip.
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
      if (cols < 1 || rows < 1) return
      try {
        socket.send(JSON.stringify({ type: 'pty-resize', cols, rows }))
      } catch {
        /* socket may have just closed */
      }
    },
  }
}
