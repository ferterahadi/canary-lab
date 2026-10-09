import Fastify, { type FastifyInstance } from 'fastify'
import type { WorkspaceEvent } from '../../../../../../../shared/workspace-events'
import { captureEvents } from '../../../../shared/__fixtures__/workspace-events'
import { featureConfigRoutes } from '../feature-config'

export interface FeatureConfigAppOptions {
  isRepoActive?: (feature: string, repo: string) => boolean
  events?: WorkspaceEvent[]
  featureRename?: {
    blockedBy: (feature: string) => string | null
    apply: (from: string, to: string) => number
  }
}

/** Registers the feature-config routes over `featuresDir` and waits until ready. */
export async function buildFeatureConfigApp(featuresDir: string, opts: FeatureConfigAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(async (a) => {
    await featureConfigRoutes(a, {
      featuresDir,
      isRepoActive: opts.isRepoActive,
      ...(opts.featureRename ? { featureRename: opts.featureRename } : {}),
      workspaceEvents: opts.events ? captureEvents(opts.events) : undefined,
    })
  })
  await app.ready()
  return app
}
