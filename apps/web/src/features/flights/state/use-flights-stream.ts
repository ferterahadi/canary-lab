import { useEffect, useReducer, useRef } from 'react'
import { connectReconnectingSocket, defaultWsBase } from '@/shared/api/reconnecting-socket'
import {
  EMPTY_FLIGHTS_STREAM,
  flightsStreamReducer,
  parseFlightsFrame,
  type FlightsStreamState,
} from './flights-stream-state'

// React wiring for `/ws/flights`. Always-on (reconnect forever, like the
// workspace bus) because a server restart must not leave the flights list
// frozen until someone reloads.
//
// `onReconnect` exists for the same reason the workspace bus has one: the
// socket carries no replay, so anything that happened while it was down is
// lost. The server sends a fresh `snapshot` on every connect, which closes that
// gap by itself — the callback is for consumers with state of their OWN keyed
// to flights (the open flight's detail read).

export interface UseFlightsStreamOptions {
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
  /** Fired on every RE-open, not the first connect. */
  onReconnect?: () => void
}

export function useFlightsStream(opts: UseFlightsStreamOptions = {}): FlightsStreamState {
  const [state, dispatch] = useReducer(flightsStreamReducer, EMPTY_FLIGHTS_STREAM)
  const onReconnectRef = useRef(opts.onReconnect)
  onReconnectRef.current = opts.onReconnect
  const { wsBase, WebSocketImpl } = opts

  useEffect(() => {
    const base = wsBase ?? defaultWsBase()
    let opened = false
    let conn: { close(): void } | null = null
    try {
      conn = connectReconnectingSocket({
        url: `${base}/ws/flights`,
        WebSocketImpl,
        maxReconnects: Infinity,
        reconnectDelayMs: 1500,
        onOpen: () => {
          if (opened) onReconnectRef.current?.()
          opened = true
        },
        onMessage: (data) => {
          const frame = parseFlightsFrame(data)
          if (frame) dispatch(frame)
        },
      })
    } catch {
      // No WebSocket in this environment (a component unit test): the caller's
      // REST load still fills the list — it just won't update live.
    }
    return () => conn?.close()
  }, [wsBase, WebSocketImpl])

  return state
}
