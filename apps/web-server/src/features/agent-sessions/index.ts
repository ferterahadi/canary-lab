import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../../server-context'
import { agentSessionStreamRoutes } from './ws/agent-session-stream'

/**
 * Live view of a spawned agent's CLI session log. Stream-only — the session
 * files are written by the agent process, so this feature has no routes of its
 * own and no store; it reads run records to resolve which log to tail.
 */
export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  await app.register(agentSessionStreamRoutes, {
    store: ctx.runStore,
    logsDir: ctx.logsDir,
    coverageProjectRoot: ctx.projectRoot,
  })
}
