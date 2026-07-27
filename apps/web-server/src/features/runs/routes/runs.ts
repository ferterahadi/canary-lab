// Runs REST surface. The handlers live in the three sibling modules below; this
// module keeps the exported entry point the server wires and composes them.
import type { FastifyInstance } from 'fastify'
import type { RunsRouteDeps } from './runs-route-deps'

export type { RunsRouteDeps } from './runs-route-deps'
export type { ExternalHealAgentRequest } from './runs-route-support'

import { registerRunActionRoutes } from './runs-actions'
import { registerRunCleanupRoutes } from './runs-cleanup-routes'
import { registerRunReadRoutes } from './runs-read'

export async function runsRoutes(app: FastifyInstance, deps: RunsRouteDeps): Promise<void> {
  await registerRunReadRoutes(app, deps)
  await registerRunActionRoutes(app, deps)
  await registerRunCleanupRoutes(app, deps)
}
