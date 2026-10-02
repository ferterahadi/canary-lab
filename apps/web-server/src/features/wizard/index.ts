import type { FastifyInstance } from 'fastify'

import { testsDraftRoutes, type TestsDraftRouteDeps } from './routes/tests-draft'

import type { ServerContext } from '../../server-context'

/**
 * Test authoring: the draft pipeline and the plan/spec agent spawns behind it. Production picks a real agent from project settings; tests inject `testsDraftDepsOverride`.
 *
 * Body lifted verbatim out of createServer — only the enclosing function and the
 * context destructuring below are new.
 */
export async function register(app: FastifyInstance, ctx: ServerContext) {
  const opts = ctx.options
  const { projectRoot, logsDir, workspaceEvents } = ctx

  // Draft routes are read/track-only: every draft is authored by an external
  // MCP client, so there is no agent to pick and none to spawn.
  const testsDraftDeps: TestsDraftRouteDeps = {
    logsDir,
    projectRoot,
    workspaceEvents,
    ...(opts.testsDraftDepsOverride ?? {}),
  }
  await app.register(testsDraftRoutes, testsDraftDeps)
}
