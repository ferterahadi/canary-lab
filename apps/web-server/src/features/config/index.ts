import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus } from '../../../../../shared/run-state'
import { featuresRoutes } from './routes/features'
import { discoveryRepairRoutes } from './routes/discovery-repair'
import { discoveryRepairStore } from './logic/discovery-repair-store'
import { featureConfigRoutes } from './routes/feature-config'
import { projectConfigRoutes } from './routes/project-config'
import { agentProbeRoutes } from './routes/agent-probe'
import { onboardingRoutes } from './routes/onboarding'

import { removeFlightRecordsForFeature } from '../flights/logic/flight-queue'
import { isActiveFlightStatus } from '../../../../../shared/flights/types'
import { renameFeatureRecords } from './logic/feature-rename'
import { runStartRequestStore } from '../runs/logic/run-start-requests'
import { agentJobStore as sharedAgentJobStore } from '../agent-sessions/logic/agent-jobs/store'

import type { ServerContext } from '../../server-context'

/**
 * Feature and project configuration: the suite list, per-feature config authoring (incl. rename, which must carry every record that stamped the old name), and project-level settings.
 *
 * Body lifted verbatim out of createServer — only the enclosing function and the
 * context destructuring below are new.
 */
export async function register(app: FastifyInstance, ctx: ServerContext) {
  const opts = ctx.options
  const {
    projectRoot,
    featuresDir,
    logsDir,
    runStore,
    benchmarkStore,
    portifyStore,
    coverageJobStore,
    flightStore,
    dirtySpecStore,
    workspaceEvents,
  } = ctx

  await app.register(featuresRoutes, { featuresDir, logsDir, dirtySpecStore, workspaceEvents })
  await app.register(discoveryRepairRoutes, { projectRoot, featuresDir, logsDir, workspaceEvents })
  // A suite's `name` IS its identity — renaming it must carry every record that
  // stamped the old name along, or the history orphans behind a name nothing
  // resolves (a flight row and its suite showing up as two separate things).
  // Refused outright while live work still holds the old name: a running
  // orchestrator/conductor addresses its feature by name and would lose it.
  const activeDiscoveryRepair = (featureName: string) => discoveryRepairStore(logsDir).list()
    .find((r) => r.feature === featureName && (r.status === 'repairing' || r.status === 'verifying'))
  const featureRenameBlockedBy = (featureName: string): string | null => {
    const repair = activeDiscoveryRepair(featureName)
    if (repair) return `discovery repair ${repair.id} is active — finish it before renaming the suite`
    const request = runStartRequestStore(logsDir).list().find((entry) => entry.feature === featureName
      && typeof entry.status === 'string' && ['awaiting-review', 'ready', 'starting'].includes(entry.status))
    if (request) return `run request ${request.id} is pending — cancel it or let it finish before renaming the suite`
    const run = runStore.list({ feature: featureName }).find((r) => isActiveRunStatus(r.status))
    if (run) return `run ${run.runId} is ${run.status} — stop it before renaming the suite`
    const flight = flightStore
      .list()
      .find((f) => f.feature === featureName && isActiveFlightStatus(f.status))
    if (flight) return `flight ${flight.flightId} is ${flight.status} — pause it before renaming the suite`
    return null
  }
  const isRepoActive = (featureName: string): boolean => Boolean(activeDiscoveryRepair(featureName)) || runStore
    .list({ feature: featureName })
    .some((run) => isActiveRunStatus(run.status))
  await app.register(featureConfigRoutes, {
    featuresDir,
    repositoryObserver: ctx.repositoryObserver,
    workspaceEvents,
    isRepoActive,
    // R76: deleting a suite deletes its flight history with it.
    removeFlightRecordsFor: (featureName) => removeFlightRecordsForFeature(flightStore, featureName),
    featureRename: {
      blockedBy: featureRenameBlockedBy,
      apply: (from, to) => renameFeatureRecords(from, to, {
        logsDir,
        stores: [flightStore, coverageJobStore, portifyStore, benchmarkStore, dirtySpecStore, sharedAgentJobStore(logsDir), discoveryRepairStore(logsDir), runStartRequestStore(logsDir)],
        activeWork: featureRenameBlockedBy,
      }).moved,
    },
  })
  await app.register(projectConfigRoutes, {
    projectRoot: projectRoot,
    countActiveRuns: () => runStore.list().filter((run) => isActiveRunStatus(run.status)).length,
    onPortChange: opts.onPortChange,
    workspaceEvents,
  })
  await app.register(agentProbeRoutes)
  await app.register(onboardingRoutes, { projectRoot, featuresDir, sessionStore: ctx.gettingStarted })
  return { isRepoActive }
}
