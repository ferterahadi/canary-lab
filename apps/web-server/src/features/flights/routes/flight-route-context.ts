// The per-registration state every flights route module shares: the stores and
// the conductor deps. Built once by `flightsRoutes` and threaded into each
// sibling registrar — building it per module would hand each one its own
// `FlightRunStore`, and the stores carry event listeners.
import { FlightRunStore, type FlightStore } from '../logic/store'
import { PlanFeaturesStore } from '../logic/plan-features'
import type { FlightConductorDeps } from '../logic/conductor'
import { buildStageEntryLinkResolver, buildStageEntryValidator } from './flight-route-support'
import type { FlightRouteDeps } from './flight-route-deps'
import { bridgeStoreEvents } from '../../../shared/store-event-bridge'

/** Long enough to fold a stage transition's cluster of writes into one client
 *  refetch, short enough that the UI still reads as live. */
const FLIGHT_EVENT_COALESCE_MS = 100

export interface FlightRouteContext {
  store: FlightStore
  planStore: PlanFeaturesStore
  conductorDeps: FlightConductorDeps
}

export function buildFlightRouteContext(deps: FlightRouteDeps): FlightRouteContext {
  const store = deps.flightStore ?? new FlightRunStore(deps.logsDir)
  const planStore = deps.planStore ?? new PlanFeaturesStore(deps.logsDir)
  // The stores ARE the emitters: every flight or plan write broadcasts from
  // here, so no route, MCP tool or conductor step has to remember to publish.
  // Attached at the one place both instances are known — the conductor deps
  // below carry the same `store`, so a stage transition rides the same bridge
  // as a route call. Coalesced because a driving flight saves far more often
  // than the old hand-placed publishes fired.
  bridgeStoreEvents(store, deps.workspaceEvents, () => ({ type: 'flights-changed' }), { coalesceMs: FLIGHT_EVENT_COALESCE_MS })
  bridgeStoreEvents(planStore, deps.workspaceEvents, () => ({ type: 'pre-flight-changed' }), { coalesceMs: FLIGHT_EVENT_COALESCE_MS })
  return {
    store,
    planStore,
    conductorDeps: {
      store,
      adapters: deps.adapters,
      workspaceEvents: deps.workspaceEvents,
      validateStageEntry: buildStageEntryValidator(deps.featuresDir, deps.logsDir),
      resolveStageEntryLinks: buildStageEntryLinkResolver(deps.logsDir),
    },
  }
}
