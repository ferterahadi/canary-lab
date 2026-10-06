import { useCallback, useEffect, useReducer, useRef } from 'react'
import { connectReconnectingSocket, defaultWsBase } from '@/shared/api/reconnecting-socket'
import { listFlights } from '@/shared/api/flights'
import { FLIGHT_ATTENTION_RECONCILE_MS } from '@shared/flights/attention'
import { withUnverifiedAttention } from '../lib/attention-history'
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

const RECONNECTING_REASON = 'Could not verify current state. Reconnecting…'

export function useFlightsStream(opts: UseFlightsStreamOptions = {}): FlightsStreamState & { forgetFlight: (id: string) => void } {
  const [state, dispatch] = useReducer(flightsStreamReducer, EMPTY_FLIGHTS_STREAM)
  const stateRef = useRef(state)
  stateRef.current = state
  const observed = useRef(0)
  const forgetFlight = useCallback((flightId: string) => { observed.current++; dispatch({ type: 'removed', flightId }) }, [])
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
          if (frame) { observed.current++; dispatch(frame) }
        },
      })
    } catch {
      // No WebSocket in this environment (a component unit test): the caller's
      // REST load still fills the list — it just won't update live.
    }
    return () => conn?.close()
  }, [wsBase, WebSocketImpl])

  useEffect(() => {
    let closed = false
    let request = 0
    const timer = setInterval(() => {
      if (!stateRef.current.flights.some((f) => f.status === 'paused')) return
      const version = observed.current
      const token = ++request
      const superseded = (): boolean => closed || token !== request || version !== observed.current
      listFlights().then((flights) => {
        if (superseded()) return
        const details = Object.fromEntries(flights.flatMap((entry) => {
          const detail = stateRef.current.details[entry.flightId]
          return detail && detail.updatedAt === entry.updatedAt
            ? [[entry.flightId, { ...detail, attention: entry.attention }]] : []
        }))
        dispatch({ type: 'snapshot', flights, details })
      }).catch(() => {
        if (superseded()) return
        // A retained resolution is not confirmed current while the read path
        // is unavailable. The next successful snapshot replaces this warning.
        const current = stateRef.current
        dispatch({
          type: 'snapshot',
          flights: current.flights.map((f) => withUnverifiedAttention(f, RECONNECTING_REASON)),
          details: Object.fromEntries(Object.entries(current.details).map(([id, m]) => [id, withUnverifiedAttention(m, RECONNECTING_REASON)])),
        })
      })
    }, FLIGHT_ATTENTION_RECONCILE_MS)
    return () => { closed = true; clearInterval(timer) }
  }, [])

  return { ...state, forgetFlight }
}
