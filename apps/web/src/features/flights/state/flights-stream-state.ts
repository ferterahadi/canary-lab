import type { FlightIndexEntry, FlightManifest } from '@/shared/api/client'

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

/** The index row the list renders, derived from the manifest the server pushed.
 *  Keeping this in one place is what lets an `update` frame maintain the list
 *  without a refetch. */
export function flightIndexEntry(m: FlightManifest): FlightIndexEntry {
  // Field for field what the server's own index builder writes
  // (flights/logic/store.ts), including `stages` — the pill's mini rail reads
  // it, and a row rebuilt without it would blank the rail between the push and
  // the next full list read.
  return {
    id: m.flightId,
    createdAt: m.createdAt,
    flightId: m.flightId,
    feature: m.feature,
    repoPaths: m.repoPaths,
    group: m.opts.group,
    status: m.status,
    pauseReason: m.pauseReason,
    currentStage: m.currentStage,
    stages: m.stages.map((s) => ({ key: s.key, status: s.status })),
    updatedAt: m.updatedAt,
    endedAt: m.endedAt,
  }
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
