import { useEffect, useRef } from 'react'
import { connectReconnectingSocket } from '@/shared/api/reconnecting-socket'
import type { createObservedReads } from './observed-reads'

/** A push-fed store's link to its server stream, as its views label it. */
export type ConnectionState =
  | 'connecting'      // initial, before the first WS open
  | 'live'            // WS open, push frames flowing
  | 'reconnecting'    // WS dropped after being live; recovery is in progress
  | 'disconnected'    // extended outage — retries continue

/** Shared connection policy for full-record streams. Domain adapters keep
 * frame shapes and reducers; observing a frame supersedes older HTTP reads. */
export interface RecordStreamOptions<Action> {
  url: string
  WebSocketImpl?: typeof WebSocket
  reads: ReturnType<typeof createObservedReads>
  decode: (frame: unknown) => Action | null
  /** null denotes a full snapshot, which invalidates every pending read. */
  recordId: (action: Action) => string | null
  dispatch: (action: Action) => void
  /** Never 'connecting': that is the store's state before this first reports. */
  onConnection: (status: Exclude<ConnectionState, 'connecting'>) => void
  reconnectDelayMs?: number
  /** Runs report prolonged outage when scheduling retry 20, including setup errors. */
  disconnectedAfterAttempts?: number
  coerceMessageData?: boolean
  onReconnect?: () => void
}

export function parseRecordFrame<Action>(data: string, decode: (frame: unknown) => Action | null): Action | null {
  try { return decode(JSON.parse(data)) } catch { return null }
}

export function connectRecordStream<Action>(opts: RecordStreamOptions<Action>): { close: () => void } {
  let closed = false
  let opened = false
  const connection = connectReconnectingSocket({
    url: opts.url,
    WebSocketImpl: opts.WebSocketImpl,
    maxReconnects: Infinity,
    reconnectDelayMs: opts.reconnectDelayMs ?? ((attempt) => Math.min(500 * 2 ** (attempt - 1), 10_000)),
    coerceMessageData: opts.coerceMessageData ?? true,
    onOpen: () => {
      if (closed) return
      opts.onConnection('live')
      if (opened) opts.onReconnect?.()
      opened = true
    },
    onReconnect: (attempt, reason) => {
      if (opts.disconnectedAfterAttempts !== undefined) {
        opts.onConnection(attempt >= opts.disconnectedAfterAttempts ? 'disconnected' : 'reconnecting')
      } else if (reason === 'close') opts.onConnection('reconnecting')
    },
    onReconnectAttempt: (_attempt, delayMs) => {
      // Preserve the existing label timing: the capped wait must elapse first.
      if (!closed && opts.disconnectedAfterAttempts === undefined && delayMs >= 10_000) opts.onConnection('disconnected')
    },
    onMessage: (data) => {
      if (closed) return
      const action = parseRecordFrame(data, opts.decode)
      if (action === null) return
      const id = opts.recordId(action)
      if (id === null) opts.reads.clear()
      else opts.reads.invalidate(id)
      opts.dispatch(action)
    },
  })
  return {
    close: () => {
      closed = true
      opts.reads.clear()
      connection.close()
    },
  }
}

/** Callback updates must not reconnect a live socket and lose intervening frames. */
export function useRecordStream<Action>(opts: RecordStreamOptions<Action> & { allowUnavailableSocket?: boolean }): void {
  const current = useRef(opts)
  current.current = opts
  const { url, WebSocketImpl, reads, reconnectDelayMs, disconnectedAfterAttempts, coerceMessageData, allowUnavailableSocket } = opts
  useEffect(() => {
    let connection: { close(): void } | undefined
    try {
      connection = connectRecordStream({ url, WebSocketImpl, reads, reconnectDelayMs, disconnectedAfterAttempts, coerceMessageData,
        decode: (frame) => current.current.decode(frame),
        recordId: (action) => current.current.recordId(action),
        dispatch: (action) => current.current.dispatch(action),
        onConnection: (status) => current.current.onConnection(status),
        onReconnect: () => current.current.onReconnect?.(),
      })
    } catch (error) {
      // Flight has an existing REST fallback when this environment has no socket.
      if (!allowUnavailableSocket) throw error
    }
    return () => connection?.close()
  }, [url, WebSocketImpl, reads, reconnectDelayMs, disconnectedAfterAttempts, coerceMessageData, allowUnavailableSocket])
}
