// Flights REST surface. The handlers live in the four sibling modules below;
// this module builds the shared route context once and composes them.
import type { FastifyInstance } from 'fastify'
import { drainQueuedFlights } from '../logic/flight-queue'
import type { FlightRouteDeps } from './flight-route-deps'
import { buildFlightRouteContext } from './flight-route-context'
import { registerFlightControlRoutes } from './flights-control'
import { registerFlightLifecycleRoutes } from './flights-lifecycle'
import { registerFlightPlanRoutes } from './flights-plan'
import { registerFlightReadRoutes } from './flights-read'
import { registerFlightStartRoutes } from './flights-start'

export type { FlightRouteDeps } from './flight-route-deps'
export { buildStageEntryValidator, executePlannedLaunch } from './flight-route-support'
export type { PlannedLaunchDeps } from './flight-route-support'

export async function flightsRoutes(app: FastifyInstance, deps: FlightRouteDeps): Promise<void> {
  const ctx = buildFlightRouteContext(deps)
  await registerFlightReadRoutes(app, deps, ctx)
  await registerFlightControlRoutes(app, deps, ctx)
  await registerFlightStartRoutes(app, deps, ctx)
  await registerFlightLifecycleRoutes(app, deps, ctx)
  await registerFlightPlanRoutes(app, deps, ctx)

  // Adapters exist only once the server has wired them, so a boot that finds a
  // queued flight can only drain it here — reconcile parked the running flight
  // `paused`, so a `queued` sibling whose repos are free can proceed now.
  drainQueuedFlights(ctx.conductorDeps)
}
