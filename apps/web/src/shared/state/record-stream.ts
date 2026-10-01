import { connectReconnectingSocket } from '@/shared/api/reconnecting-socket'
import type { createObservedReads } from './observed-reads'

/** A push-fed store's link to its server stream, as its views label it. */
export type ConnectionState =
  | 'connecting'      // initial, before the first WS open
  | 'live'            // WS open, push frames flowing
  | 'reconnecting'    // WS dropped after being live; recovery is in progress
  | 'disconnected'    // gave up — surfaced to the user as a banner

/** Shared connection policy for full-record streams. Domain adapters keep
 * frame shapes and reducers; observing a frame supersedes older HTTP reads. */
export function connectRecordStream<Action>(opts: {
  url: string
  WebSocketImpl?: typeof WebSocket
  reads: ReturnType<typeof createObservedReads>
  decode: (frame: unknown) => Action | null
  /** null denotes a full snapshot, which invalidates every pending read. */
  recordId: (action: Action) => string | null
  dispatch: (action: Action) => void
  /** Never 'connecting': that is the store's state before this first reports. */
  onConnection: (status: Exclude<ConnectionState, 'connecting'>) => void
}): { close: () => void } {
  let closed = false
  const connection = connectReconnectingSocket({
    url: opts.url,
    WebSocketImpl: opts.WebSocketImpl,
    maxReconnects: Infinity,
    reconnectDelayMs: (attempt) => Math.min(500 * 2 ** (attempt - 1), 10_000),
    coerceMessageData: true,
    onOpen: () => { if (!closed) opts.onConnection('live') },
    onReconnect: (_attempt, reason) => {
      if (!closed && reason === 'close') opts.onConnection('reconnecting')
    },
    onReconnectAttempt: (_attempt, delayMs) => {
      // Preserve the existing label timing: the capped wait must elapse first.
      if (!closed && delayMs >= 10_000) opts.onConnection('disconnected')
    },
    onMessage: (data) => {
      if (closed) return
      let action: Action | null
      try { action = opts.decode(JSON.parse(data)) } catch { return }
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
