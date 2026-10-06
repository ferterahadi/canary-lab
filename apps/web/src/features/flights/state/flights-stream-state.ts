import { createRecordIndex } from '@/shared/state/record-index-store'
import { parseRecordFrame } from '@/shared/state/record-stream'
import type { FlightIndexEntry, FlightManifest } from '@shared/flights/types'
import { flightIndexEntry } from '@shared/flights/index-entry'

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

export const flightIndex = createRecordIndex<FlightIndexEntry, FlightManifest, 'flights', 'flightId'>({
  keys: { list: 'flights', id: 'flightId' },
  entryOf: flightIndexEntry,
  compareEntries: (a, b) => a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
})

export function flightsStreamReducer(state: FlightsStreamState, frame: FlightsStreamFrame): FlightsStreamState {
  const next = flightIndex.reducer({ ...state, connection: 'connecting' }, frame)
  return { flights: next.flights, details: next.details, hydrated: state.hydrated || frame.type === 'snapshot' }
}

export function decodeFlightsFrame(frame: unknown): FlightsStreamFrame | null {
  return flightIndex.frameToAction(frame) as FlightsStreamFrame | null
}

export function parseFlightsFrame(data: string): FlightsStreamFrame | null {
  return parseRecordFrame(data, decodeFlightsFrame)
}
