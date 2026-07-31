import path from 'path'
import type { FastifyInstance } from 'fastify'
import { runsRoutes } from './routes/runs'
import { journalRoutes } from './routes/journal'
import { makeAttachRunStreams, makeRestartExternalRun } from './run-stream-wiring'
import { buildRunScheduling } from './run-scheduling'
import { buildRunsRouteDeps } from './runs-route-deps'
import { makeRestartLocalHeal } from './restart-local-heal'
import { externalHealRoutes } from './routes/external-heal'
import { paneStreamRoutes } from './ws/pane-stream'
import { runsStreamRoutes } from './ws/runs-stream'
import type { ServerContext } from '../../server-context'

/**
 * The run loop: start/queue/admit, service boot, Playwright, heal cycles, the external-heal broker surface, and the pane/run streams. The largest feature by far — Phase 8 splits it further.
 *
 * Body lifted verbatim out of createServer — only the enclosing function and the
 * context destructuring below are new.
 */
export async function register(app: FastifyInstance, ctx: ServerContext) {
  const {
    projectRoot,
    featuresDir,
    logsDir,
    journalPath,
    registry,
    runStore,
    benchmarkStore,
    dirtySpecStore,
    workspaceEvents,
    externalHealBroker,
    brokers,
    activeEnvsets,
    ptyFactory,
  } = ctx

  await app.register(journalRoutes, { logsDir, journalPath })
  // `restartLocalHeal` deferred until after the runs route declares its
  // production restartHeal closure — defined below and threaded back in via
  // a setter-style hook on the route deps.
  const externalHealDeps: Parameters<typeof externalHealRoutes>[1] = {
    store: runStore,
    broker: externalHealBroker,
  }
  await app.register(externalHealRoutes, externalHealDeps)

  const attachRunStreams = makeAttachRunStreams(ctx)
  const restartExternalRun = makeRestartExternalRun(ctx, attachRunStreams)
  const scheduling = buildRunScheduling(ctx)
  const { scheduler } = scheduling
  const restartLocalHeal = makeRestartLocalHeal(ctx, attachRunStreams)
  await app.register(
    runsRoutes,
    buildRunsRouteDeps(ctx, { attachRunStreams, restartExternalRun, scheduling, restartLocalHeal }),
  )
  // The external-heal handoff route reads `deps.restartLocalHeal` at request
  // time, so binding it after the runs route is registered is still in time.
  externalHealDeps.restartLocalHeal = (runId, guidance) => restartLocalHeal(runId, guidance)
  await app.register(paneStreamRoutes, {
    registry,
    brokerFor: (runId) => brokers.get(runId) ?? null,
    logsDir,
  })
  await app.register(runsStreamRoutes, { store: runStore })

  return { scheduler, attachRunStreams, restartExternalRun }
}

/**
 * What the run loop hands back to the composition root: the scheduler and stream
 * attacher benchmark reuses, and the external-run restart the MCP surface drives.
 * Inferred rather than declared so it cannot drift from what register returns.
 */
export type RunsFeature = Awaited<ReturnType<typeof register>>
