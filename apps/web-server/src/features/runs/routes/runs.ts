// Runs REST surface. The handlers live in the three sibling modules below; this
// module keeps the exported entry point the server wires and composes them.
import type { FastifyInstance } from 'fastify'
import type { RunsRouteDeps } from './runs-route-deps'

export type { RunsRouteDeps } from './runs-route-deps'
export type { ExternalHealAgentRequest } from './runs-route-support'

import { registerRunActionRoutes } from './runs-actions'
import { registerRunCleanupRoutes } from './runs-cleanup-routes'
import { registerRunTestReviewRoutes } from './runs-test-review'
import { registerRunReadRoutes } from './runs-read'
import { registerRunStartRequests } from './run-start-requests'

export async function runsRoutes(app: FastifyInstance, deps: RunsRouteDeps): Promise<void> {
  deps = { ...deps, runRequests: registerRunStartRequests(app, deps) }
  await registerRunReadRoutes(app, deps)
  await registerRunTestReviewRoutes(app, deps)
  await registerRunActionRoutes(app, deps)
  await registerRunCleanupRoutes(app, deps)
}
