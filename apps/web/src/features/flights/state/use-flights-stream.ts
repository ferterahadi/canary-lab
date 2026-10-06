import { useRecordStream } from '@/shared/state/record-stream'
import { createObservedReads } from '@/shared/state/observed-reads'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { defaultWsBase } from '@/shared/api/reconnecting-socket'
import { listFlights } from '@/shared/api/flights'
import { FLIGHT_ATTENTION_RECONCILE_MS } from '@shared/flights/attention'
import { withUnverifiedAttention } from '../lib/attention-history'
import {
  EMPTY_FLIGHTS_STREAM,
  flightsStreamReducer,
  decodeFlightsFrame,
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
  const reads = useRef(createObservedReads()).current
  const apply = useCallback((frame: Parameters<typeof flightsStreamReducer>[1]) => {
    reads.clear()
    dispatch(frame)
  }, [reads])
  const forgetFlight = useCallback((flightId: string) => apply({ type: 'removed', flightId }), [apply])
  useRecordStream({
    url: `${opts.wsBase ?? defaultWsBase()}/ws/flights`,
    WebSocketImpl: opts.WebSocketImpl,
    reads,
    reconnectDelayMs: 1500,
    onReconnect: opts.onReconnect,
    allowUnavailableSocket: true,
    decode: decodeFlightsFrame,
    recordId: (frame) => frame.type === 'snapshot' ? null : frame.flightId,
    dispatch: apply,
    onConnection: () => {},
  })

  useEffect(() => {
    let closed = false
    const timer = setInterval(() => {
      if (!stateRef.current.flights.some((f) => f.status === 'paused')) return
      const key = 'attention'
      // Each interval supersedes a hung read, just as a push supersedes it.
      reads.invalidate(key)
      const token = reads.begin(key)!
      const superseded = (): boolean => closed || !reads.current(key, token)
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
      }).finally(() => reads.finish(key, token))
    }, FLIGHT_ATTENTION_RECONCILE_MS)
    return () => { closed = true; reads.clear(); clearInterval(timer) }
  }, [reads])

  return { ...state, forgetFlight }
}
