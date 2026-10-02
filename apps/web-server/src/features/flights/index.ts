import type { FastifyInstance } from 'fastify'

import { flightsRoutes } from './routes/flights'
import { flightsStreamRoutes } from './ws/flights-stream'
import { buildFlightStageAdapters } from './logic/stages/index'

import type { ServerContext } from '../../server-context'

/**
 * Flight pipeline: the conducted end-to-end run from bare repo to evaluation export. Stage adapters drive runs/portify/evaluation through their own HTTP routes, so admission, collision and store wiring stay in one place.
 *
 * Body lifted verbatim out of createServer — only the enclosing function and the
 * context destructuring below are new.
 */
export async function register(app: FastifyInstance, ctx: ServerContext) {
  const { projectRoot, featuresDir, logsDir, flightStore, planStore, workspaceEvents } = ctx

  await app.register(flightsRoutes, {
    featuresDir,
    logsDir,
    projectRoot: projectRoot,
    flightStore,
    planStore,
    workspaceEvents,
    gettingStarted: ctx.gettingStarted,
    repositoryObserver: ctx.repositoryObserver,
    adapters: buildFlightStageAdapters({
      featuresDir,
      logsDir,
      projectRoot: projectRoot,
      workspaceEvents,
      // Same-process HTTP reuse: stage adapters drive runs/portify/evaluation
      // through their routes (admission, collision, store wiring live there).
      inject: async (o) => {
        const resp = await app.inject({
          method: o.method,
          url: o.url,
          ...(o.payload !== undefined ? { payload: o.payload as Record<string, unknown> } : {}),
        })
        return { statusCode: resp.statusCode, json: () => resp.json() as unknown }
      },
    }),
  })

  // The push channel for the same store the routes above write. Registered
  // after them so the store is already bridged to the workspace bus — the two
  // are complements, not alternatives: the bus tells every surface "flights
  // moved", this one carries the manifest to whoever is watching.
  await app.register(flightsStreamRoutes, { store: flightStore })
}
