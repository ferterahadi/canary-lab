import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../../server-context'
import { agentSessionStreamRoutes } from './ws/agent-session-stream'
import { agentJobRoutes } from './routes/agent-jobs'

/**
 * Spawned-agent surfaces: the live view of an agent's CLI session log (stream —
 * the session files are written by the agent process itself), plus the durable
 * agent-job records that say which agents ran, how each ended, and which are
 * still live enough to stop.
 */
export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  await app.register(agentSessionStreamRoutes, {
    store: ctx.runStore,
    logsDir: ctx.logsDir,
    coverageProjectRoot: ctx.projectRoot,
  })
  await app.register(agentJobRoutes, { logsDir: ctx.logsDir })
}
