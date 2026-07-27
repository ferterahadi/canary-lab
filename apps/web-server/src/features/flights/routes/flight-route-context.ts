// The per-registration state every flights route module shares: the stores and
// the conductor deps. Built once by `flightsRoutes` and threaded into each
// sibling registrar — building it per module would hand each one its own
// `FlightRunStore`, and the stores carry event listeners.
import { FlightRunStore, type FlightStore } from '../logic/store'
import { PlanFeaturesStore } from '../logic/plan-features'
import type { FlightConductorDeps } from '../logic/conductor'
import { buildStageEntryValidator } from './flight-route-support'
import type { FlightRouteDeps } from './flight-route-deps'

export interface FlightRouteContext {
  store: FlightStore
  planStore: PlanFeaturesStore
  conductorDeps: FlightConductorDeps
}

export function buildFlightRouteContext(deps: FlightRouteDeps): FlightRouteContext {
  const store = deps.flightStore ?? new FlightRunStore(deps.logsDir)
  const planStore = deps.planStore ?? new PlanFeaturesStore(deps.logsDir)
  return {
    store,
    planStore,
    conductorDeps: {
      store,
      adapters: deps.adapters,
      workspaceEvents: deps.workspaceEvents,
      validateStageEntry: buildStageEntryValidator(deps.featuresDir, deps.logsDir),
    },
  }
}
