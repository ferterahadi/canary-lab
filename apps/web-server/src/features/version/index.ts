import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../../server-context'
import { versionRoutes } from './routes/version'

/**
 * Self-update surface: the running version, the registry check, and the
 * install job. The `VersionState` snapshot and `UpdateJobStore` are built at
 * boot (a successful install rewrites package.json but the running code stays
 * old until restart, so the snapshot has to outlive this registration).
 */
export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  await app.register(versionRoutes, {
    projectRoot: ctx.projectRoot,
    state: ctx.versionState,
    updateStore: ctx.updateStore,
    workspaceEvents: ctx.workspaceEvents,
  })
}
