// Feature-config REST surface. The handlers live in the four sibling modules
// below; this module keeps the exported entry point the server wires.
import type { FastifyInstance } from 'fastify'
import type { FeatureConfigRouteDeps } from './feature-config-deps'

export type { FeatureConfigRouteDeps } from './feature-config-deps'

import { registerEnvsetRoutes } from './envset-routes'
import { registerFeatureConfigDocRoutes } from './feature-config-doc'
import { registerPlaywrightConfigRoutes } from './playwright-config-routes'
import { registerWorkspaceFsRoutes } from './workspace-fs-routes'

export async function featureConfigRoutes(app: FastifyInstance, deps: FeatureConfigRouteDeps): Promise<void> {
  await registerFeatureConfigDocRoutes(app, deps)
  await registerPlaywrightConfigRoutes(app, deps)
  await registerEnvsetRoutes(app, deps)
  await registerWorkspaceFsRoutes(app, deps)
}
