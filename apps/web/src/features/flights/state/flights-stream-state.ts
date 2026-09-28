import type { FlightIndexEntry, FlightManifest } from '@/shared/api/client'
import { flightIndexEntry } from '@shared/flights/index-entry'

export { flightIndexEntry } from '@shared/flights/index-entry'

// Pure reducer behind the `/ws/flights` push channel. Mirrors
// portify-state.ts / runs-state.ts so it unit-tests in the node vitest config
// (no jsdom); the React wiring is in use-flights-stream.ts.
//
// What it replaces: the flights list used to be a REST array refetched on every
// best-effort `flights-changed` nudge, PLUS a 5s poll to cover a nudge that
// never arrived. The server now pushes the full manifest on every store write,
// so a driving flight's rail advances from the push itself — no round trip, no
// poll, and no window where the list is stale because one frame was lost.

export type FlightsStreamFrame =
  | { type: 'snapshot'; flights: FlightIndexEntry[]; details: Record<string, FlightManifest> }
  | { type: 'update'; flightId: string; manifest: FlightManifest }
  | { type: 'removed'; flightId: string }

export interface FlightsStreamState {
  /** The index, newest-first — exactly what `GET /api/flights` returns, so
   *  every consumer of the old REST list reads this unchanged. */
  flights: FlightIndexEntry[]
  /** Full manifests for the flights the server pushed. Active ones arrive in
   *  the snapshot; any flight the user has open arrives on its next write. */
  details: Record<string, FlightManifest>
  /** False until the first snapshot lands, so a consumer can keep showing its
   *  REST-loaded list rather than blinking to empty while the socket opens. */
  hydrated: boolean
}

export const EMPTY_FLIGHTS_STREAM: FlightsStreamState = {
  flights: [],
  details: {},
  hydrated: false,
}

function byCreatedDesc(a: FlightIndexEntry, b: FlightIndexEntry): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
}

export function flightsStreamReducer(
  state: FlightsStreamState,
  frame: FlightsStreamFrame,
): FlightsStreamState {
  switch (frame.type) {
    case 'snapshot':
      return { flights: frame.flights, details: frame.details, hydrated: true }
    case 'update': {
      const entry = flightIndexEntry(frame.manifest)
      const others = state.flights.filter((f) => f.flightId !== frame.flightId)
      return {
        ...state,
        flights: [entry, ...others].sort(byCreatedDesc),
        details: { ...state.details, [frame.flightId]: frame.manifest },
      }
    }
    case 'removed': {
      const { [frame.flightId]: _dropped, ...details } = state.details
      return {
        ...state,
        flights: state.flights.filter((f) => f.flightId !== frame.flightId),
        details,
      }
    }
  }
}

/** Parse a raw frame; anything unrecognised is dropped rather than thrown, so
 *  one malformed payload can't tear down the socket. */
export function parseFlightsFrame(data: string): FlightsStreamFrame | null {
  let frame: unknown
  try {
    frame = JSON.parse(data)
  } catch {
    return null
  }
  // `JSON.parse('null')` succeeds and yields null, so the shape check has to
  // come before the property read.
  if (!frame || typeof frame !== 'object') return null
  const type = (frame as { type?: unknown }).type
  if (type === 'snapshot' || type === 'update' || type === 'removed') {
    return frame as FlightsStreamFrame
  }
  return null
}
