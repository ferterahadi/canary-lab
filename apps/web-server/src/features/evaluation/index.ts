import type { FastifyInstance } from 'fastify'

import { evaluationRoutes } from './routes/evaluation'

import type { ServerContext } from '../../server-context'

/**
 * Evaluation export (HTML/zip + task lifecycle + live agent session). Reads finished runs through the shared run store.
 *
 * Body lifted verbatim out of createServer — only the enclosing function and the
 * context destructuring below are new.
 */
export async function register(app: FastifyInstance, ctx: ServerContext) {
  const { projectRoot, featuresDir, runStore, workspaceEvents } = ctx

  // Evaluation export (HTML/zip + task lifecycle + live agent-session) — its own
  // feature router. Reads finished runs through the shared run store; defaults to
  // the built-in localized-rewrite agent (the `generateEvaluationRewrite` dep is a
  // test-only seam).
  await app.register(evaluationRoutes, {
    featuresDir,
    projectRoot: projectRoot,
    store: runStore,
    workspaceEvents,
  })
}
