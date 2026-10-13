import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { flightsRoutes } from '../flights'
import type { FlightStore } from '../../logic/store'
import type { StageAdapters } from '../../logic/flight-stages'
import type { FlightAgentSpawner } from '../../logic/stages/context'
import type { PlanFeaturesStore } from '../../logic/plan-features'
import { pollUntil } from '../../../../../../../tools/test-helpers/poll-until'

/** The flights routes over a temp workspace: features under `<tmpDir>/features`,
 *  logs and project root at `tmpDir`. Each optional store or spawner replaces
 *  the default only when given, so an omitted one leaves the registrar's own. */
export async function buildFlightsApp(
  tmpDir: string,
  adapters: StageAdapters,
  flightStore?: FlightStore,
  planAgent?: FlightAgentSpawner,
  planStore?: PlanFeaturesStore,
): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false })
  await instance.register(flightsRoutes, {
    featuresDir: path.join(tmpDir, 'features'),
    logsDir: tmpDir,
    projectRoot: tmpDir,
    adapters,
    ...(flightStore ? { flightStore } : {}),
    ...(planAgent ? { planAgent } : {}),
    ...(planStore ? { planStore } : {}),
  })
  return instance
}

/** Poll `GET /api/flights/:id` until the flight reaches one of `statuses`, and
 *  return that manifest. */
export async function waitForFlightStatus(
  app: FastifyInstance,
  flightId: string,
  statuses: string[],
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return pollUntil(
    async () => (await app.inject({ method: 'GET', url: `/api/flights/${flightId}` })).json() as Record<string, unknown>,
    (manifest) => statuses.includes(String(manifest.status)),
    { timeoutMs, timeoutMessage: (manifest) => `flight never reached ${statuses.join('/')}: ${String(manifest.status)}` },
  )
}
