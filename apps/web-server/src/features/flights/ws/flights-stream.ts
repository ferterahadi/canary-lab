import { isActiveFlightStatus } from '../../../../../../shared/flights/types'
import type { FastifyInstance } from 'fastify'
import type { FlightStore, FlightStoreEvent } from '../logic/store'
import { activeDetails, registerRecordStream } from '../../../shared/ws/record-stream'
import type { FlightsStreamFrame } from '../../../../../../shared/flights/index-entry'

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
// The socket lifecycle is `registerRecordStream`'s (shared/ws/record-stream.ts,
// tested there); this module only maps store events to frames.

export interface FlightsStreamDeps {
  store: Pick<FlightStore, 'list' | 'get' | 'onEvent' | 'offEvent'>
}

export async function flightsStreamRoutes(
  app: FastifyInstance,
  deps: FlightsStreamDeps,
): Promise<void> {
  registerRecordStream<FlightsStreamFrame, FlightStoreEvent>(app, {
    path: '/ws/flights',
    store: deps.store,
    snapshot: () => {
      const flights = deps.store.list()
      const details = activeDetails(flights, (entry) => isActiveFlightStatus(entry.status), (entry) => entry.flightId, (id) => deps.store.get(id))
      return { type: 'snapshot', flights, details }
    },
    frameFor: (event) => {
      if (!event.flightId) return undefined
      if (event.kind === 'removed') return { type: 'removed', flightId: event.flightId }
      const manifest = deps.store.get(event.flightId)
      // A `changed` whose record is already gone is a delete that raced us; the
      // `removed` frame for it is either in flight or already sent.
      return manifest ? { type: 'update', flightId: event.flightId, manifest } : undefined
    },
  })
}
