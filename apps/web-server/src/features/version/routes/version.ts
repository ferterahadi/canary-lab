import type { FastifyInstance } from 'fastify'
import {
  startUpdateJob,
  UpdateJobConflictError,
  type UpdateJobStore,
  type InstallRunner,
} from '../logic/update-job'
import type { VersionState } from '../logic/version-state'
import type { WorkspaceEventPublisher } from '../../../shared/workspace-events'

export interface VersionRouteDeps {
  projectRoot: string
  state: VersionState
  updateStore: UpdateJobStore
  workspaceEvents?: WorkspaceEventPublisher
  /** Injectable installer for tests. */
  run?: InstallRunner
}

export async function versionRoutes(app: FastifyInstance, deps: VersionRouteDeps): Promise<void> {
  // Current vs latest + the self-update job state. Polled on cold load and
  // refetched whenever a `version-changed` event arrives.
  app.get('/api/version', async () => deps.state.status(deps.updateStore))

  // Kick off `npm install <pkg>@latest` in the workspace. Non-blocking: returns
  // 202 with the running manifest; the job streams into the store and flips to
  // done/failed, broadcasting `version-changed` each time.
  app.post('/api/version/update', async (_req, reply) => {
    const target = deps.state.pendingTarget()
    if (!target) {
      reply.code(409)
      return { error: 'already on the latest version (nothing to update)' }
    }
    const { packageName } = deps.state.status(deps.updateStore)
    if (!packageName) {
      reply.code(409)
      return { error: 'could not resolve the installed package name' }
    }
    try {
      const { manifest } = startUpdateJob(
        { projectRoot: deps.projectRoot, packageName, targetVersion: target },
        { store: deps.updateStore, workspaceEvents: deps.workspaceEvents, run: deps.run },
      )
      reply.code(202)
      return manifest
    } catch (err) {
      if (err instanceof UpdateJobConflictError) {
        reply.code(409)
        return { error: err.message }
      }
      throw err
    }
  })
}
