import type { FastifyInstance } from 'fastify'
import type { FlightStore } from '../logic/store'
import type { FlightIndexEntry, FlightManifest } from '../logic/types'

// `/ws/flights` — push channel for the flights list and the open flight detail,
// mirroring ws/portify-stream.ts. On connect: one `snapshot` frame (the index,
// plus details for ACTIVE flights). Store mutations then arrive as `update`
// (full manifest) / `removed`.
//
// Why a per-record stream rather than the workspace bus's `flights-changed`
// nudge: a driving flight is the one thing in this UI that changes every few
// seconds while the user watches it, and the nudge only says "something about
// some flight moved" — every client answered it with a `GET /api/flights`, and
// the list ALSO polled every 5s to cover a dropped nudge. Pushing the manifest
// itself removes both: the round trip and the poll.
//
// Coverage is excluded for this module (like the other ws/** wire-ups) — too
// thin to test deterministically without a real WebSocket round-trip. The store
// underneath and the client reducer are fully covered.

export interface FlightsStreamDeps {
  store: FlightStore
}

export type FlightsStreamFrame =
  | { type: 'snapshot'; flights: FlightIndexEntry[]; details: Record<string, FlightManifest> }
  | { type: 'update'; flightId: string; manifest: FlightManifest }
  | { type: 'removed'; flightId: string }

/** Active = still moving, so its manifest is worth pushing up front. A settled
 *  flight's detail is one REST read away and most of them are never opened. */
function isActive(status: FlightIndexEntry['status']): boolean {
  return status === 'running' || status === 'waiting-for-approval'
}

export async function flightsStreamRoutes(
  app: FastifyInstance,
  deps: FlightsStreamDeps,
): Promise<void> {
  app.get('/ws/flights', { websocket: true }, (socket) => {
    const send = (frame: FlightsStreamFrame): void => {
      try {
        socket.send(JSON.stringify(frame))
      } catch {
        /* socket closed */
      }
    }

    const snapshot = (): FlightsStreamFrame => {
      const flights = deps.store.list()
      const details: Record<string, FlightManifest> = {}
      for (const entry of flights) {
        if (!isActive(entry.status)) continue
        const manifest = deps.store.get(entry.flightId)
        if (manifest) details[entry.flightId] = manifest
      }
      return { type: 'snapshot', flights, details }
    }

    send(snapshot())

    const onEvent = (event: { kind: 'changed' | 'removed'; flightId?: string }): void => {
      if (!event.flightId) return
      if (event.kind === 'removed') {
        send({ type: 'removed', flightId: event.flightId })
        return
      }
      const manifest = deps.store.get(event.flightId)
      // A `changed` whose record is already gone is a delete that raced us; the
      // `removed` frame for it is either in flight or already sent.
      if (!manifest) return
      send({ type: 'update', flightId: event.flightId, manifest })
    }

    deps.store.onEvent(onEvent)
    socket.on('close', () => {
      deps.store.offEvent(onEvent)
    })
  })
}
