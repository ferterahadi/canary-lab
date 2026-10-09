import Fastify from 'fastify'
import type { WorkspaceEvent } from '../../../../../../../shared/workspace-events'
import { captureEvents } from '../../../../shared/__fixtures__/workspace-events'
import type { GettingStartedSessionStore } from '../../../config/logic/getting-started-session'
import { RunStore } from '../../logic/run-store'
import { createRegistry, type RestartHealResult, type RestartRunResult } from '../../logic/run-registry'
import { runsRoutes } from '../runs'

type RunsRouteDeps = Parameters<typeof runsRoutes>[1]

export interface RunsAppOptions {
  startRun?: RunsRouteDeps['startRun']
  cancelQueuedRun?: (runId: string) => boolean
  broker?: RunsRouteDeps['broker']
  restartHeal?: (runId: string, text: string) => Promise<RestartHealResult>
  restartRun?: (runId: string) => Promise<RestartRunResult>
  projectRoot?: string
  events?: WorkspaceEvent[]
  isWorktreeOwnerActive?: (kind: 'run' | 'benchmark', id: string) => boolean
  repositoryObserver?: RunsRouteDeps['repositoryObserver']
  queueDiagnostics?: RunsRouteDeps['queueDiagnostics']
  gettingStarted?: GettingStartedSessionStore
}

/**
 * Registers the runs routes over a fresh registry and store rooted at
 * `dirs.logsDir`. An unset `startRun` throws, so a test that starts a run
 * without configuring one fails loudly.
 */
export async function buildRunsApp(dirs: { logsDir: string; featuresDir: string }, opts: RunsAppOptions = {}) {
  const registry = createRegistry()
  const store = new RunStore(dirs.logsDir, registry)
  const app = Fastify()
  await app.register(runsRoutes, {
    featuresDir: dirs.featuresDir,
    projectRoot: opts.projectRoot,
    store,
    broker: opts.broker,
    startRun: opts.startRun ?? (async () => { throw new Error('not configured') }),
    cancelQueuedRun: opts.cancelQueuedRun,
    restartHeal: opts.restartHeal,
    restartRun: opts.restartRun,
    isWorktreeOwnerActive: opts.isWorktreeOwnerActive,
    repositoryObserver: opts.repositoryObserver,
    queueDiagnostics: opts.queueDiagnostics,
    gettingStarted: opts.gettingStarted,
    workspaceEvents: opts.events ? captureEvents(opts.events) : undefined,
  })
  return { app, registry, store }
}
