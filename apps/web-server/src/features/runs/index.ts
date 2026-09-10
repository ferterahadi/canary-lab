import path from 'path'
import type { FastifyInstance } from 'fastify'
import { runsRoutes } from './routes/runs'
import { journalRoutes } from './routes/journal'
import { makeAttachRunStreams, makeRestartExternalRun } from './run-stream-wiring'
import { buildRunScheduling } from './run-scheduling'
import { buildRunsRouteDeps } from './runs-route-deps'
import { makeRestartLocalHeal } from './restart-local-heal'
import { makeRobustnessCellRunner } from './logic/robustness/cell-runner'
import { robustnessRoutes } from './routes/robustness'
import { externalHealRoutes } from './routes/external-heal'
import { paneStreamRoutes } from './ws/pane-stream'
import { runsStreamRoutes } from './ws/runs-stream'
import type { ServerContext } from '../../server-context'

/**
 * The run loop: start/queue/admit, service boot, Playwright, heal cycles, the external-heal broker surface, the Robustness Lab jobs, and the pane/run streams. The largest feature by far — Phase 8 splits it further.
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
    robustnessJobStore,
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
  const runsDeps = buildRunsRouteDeps(ctx, { attachRunStreams, restartExternalRun, scheduling, restartLocalHeal })
  await app.register(runsRoutes, runsDeps)
  // The Robustness Lab runs its cells through this same start path, so the
  // runner is built here where `startRun` exists and handed out for the stage
  // and the MCP tools to drive.
  const runRobustnessCell = makeRobustnessCellRunner({ startRun: runsDeps.startRun, runStore })
  // The lab's REST surface: the flight's Robustness stage and the MCP tools both
  // start, read, stop and drop matrix jobs through it, over the process-wide job
  // store (already bridged to `robustness-changed`).
  await app.register(robustnessRoutes, { featuresDir, logsDir, store: robustnessJobStore, runCell: runRobustnessCell })
  // The external-heal handoff route reads `deps.restartLocalHeal` at request
  // time, so binding it after the runs route is registered is still in time.
  externalHealDeps.restartLocalHeal = (runId, guidance) => restartLocalHeal(runId, guidance)
  await app.register(paneStreamRoutes, {
    registry,
    brokerFor: (runId) => brokers.get(runId) ?? null,
    logsDir,
  })
  await app.register(runsStreamRoutes, { store: runStore })

  return { scheduler, attachRunStreams, restartExternalRun, runRobustnessCell }
}

/**
 * What the run loop hands back to the composition root: the scheduler and stream
 * attacher benchmark reuses, the external-run restart the MCP surface drives, and
 * the robustness cell runner the Robustness Lab job drives.
 * Inferred rather than declared so it cannot drift from what register returns.
 */
export type RunsFeature = Awaited<ReturnType<typeof register>>
