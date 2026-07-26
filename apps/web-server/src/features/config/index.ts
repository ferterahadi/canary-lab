import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus } from '../../../../../shared/run-state'
import { featuresRoutes } from '../../features/config/routes/features'
import { featureConfigRoutes } from '../../features/config/routes/feature-config'
import { projectConfigRoutes } from '../../features/config/routes/project-config'
import { runsRoutes, type ExternalHealAgentRequest } from '../../features/runs/routes/runs'
import { testsDraftRoutes, type TestsDraftRouteDeps } from '../../features/wizard/routes/tests-draft'
import { externalHealRoutes, makeExternalHealAuditLogger } from '../../features/runs/routes/external-heal'
import { createRegistry, RunStore, type OrchestratorRegistry, type OrchestratorLike, type StartRunOutcome } from '../../features/runs/logic/run-store'
import { loadBundledSabotageSkills, sabotageSkillsForFeature } from '../../features/benchmark/logic/runtime/skills'
import { removeFlightRecordsForFeature } from '../../features/flights/logic/conductor'
import { isActiveFlightStatus } from '../../../../../shared/flights/types'
import { renameFeatureRecords } from '../../features/config/logic/feature-rename'
import {
  buildAgentSessionResponse,
  resolveWorkflowAgentRef,
} from '../../features/agent-sessions/logic/agent-session-log'
import { allocateRunPorts, applyFeatureEnvset } from '../runs/logic/runtime/run-primitives'
import type { ServerContext } from '../../server-context'
import { getInstalledPackageName, getInstalledPackageVersion } from '../../../../../shared/runtime/upgrade-check'
import {
  spawnPlanAgent as makePlanAgentSpawner,
  spawnSpecAgent as makeSpecAgentSpawner,
} from '../../features/wizard/logic/wizard-agent-runner'
import { runDirFor, buildRunPaths } from '../../features/runs/logic/runtime/run-paths'
import { RunOrchestrator, collectPortSlots, buildServiceSpecs, buildQueuedServiceEntries } from '../../features/runs/logic/runtime/orchestrator'
import { RunScheduler, type SchedulerActiveRun } from '../../features/runs/logic/runtime/run-scheduler'
import { estimateRunCost, resolveAdmissionConfig, readSystemResources } from '../../features/runs/logic/runtime/admission'
import { detectRepoCollision, normalizeRepoPaths } from '../../features/runs/logic/runtime/repo-collision'
import { addWorktree, hydrateWorkingTreeDiff, linkNodeModules, type WorktreeHandle } from '../../features/runs/logic/runtime/repo-worktree'
import {
  buildAgentSpawnCommand,
  buildOrchestratorHealPrompt,
  pickAvailableHealAgent,
  resolveAgentBinary,
  type BuildHealCyclePrompt,
  type HealAgent,
} from '../../features/runs/logic/runtime/auto-heal'
import { collectRepoBranchSnapshots, validateConfiguredRepoBranches } from '../../shared/git-repo'
import { realPtyFactory, type PtyFactory } from '../../features/runs/logic/runtime/pty-spawner'
import {
  applySet,
  backup,
  getEnvSetsDir,
  loadConfig,
  resolveVars,
  restore,
} from '../../features/runs/logic/runtime/env-switcher/switch'
import {
  buildVerificationDiagnostics,
  resolveVerificationRun,
  type ResolveVerificationInput,
} from '../../features/coverage/logic/verification'

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

  await app.register(featuresRoutes, { featuresDir, dirtySpecStore })
  // A suite's `name` IS its identity — renaming it must carry every record that
  // stamped the old name along, or the history orphans behind a name nothing
  // resolves (a flight row and its suite showing up as two separate things).
  // Refused outright while live work still holds the old name: a running
  // orchestrator/conductor addresses its feature by name and would lose it.
  const featureRenameBlockedBy = (featureName: string): string | null => {
    const run = runStore.list({ feature: featureName }).find((r) => isActiveRunStatus(r.status))
    if (run) return `run ${run.runId} is ${run.status} — stop it before renaming the suite`
    const flight = flightStore
      .list()
      .find((f) => f.feature === featureName && isActiveFlightStatus(f.status))
    if (flight) return `flight ${flight.flightId} is ${flight.status} — pause it before renaming the suite`
    return null
  }
  await app.register(featureConfigRoutes, {
    featuresDir,
    workspaceEvents,
    isRepoActive: (featureName) => runStore
      .list({ feature: featureName })
      .some((run) => isActiveRunStatus(run.status)),
    // R76: deleting a suite deletes its flight history with it.
    removeFlightRecordsFor: (featureName) => removeFlightRecordsForFeature(flightStore, featureName),
    featureRename: {
      blockedBy: featureRenameBlockedBy,
      apply: (from, to) => renameFeatureRecords(from, to, {
        logsDir,
        stores: [flightStore, coverageJobStore, portifyStore, benchmarkStore, dirtySpecStore],
        activeWork: featureRenameBlockedBy,
      }).moved,
    },
  })
  await app.register(projectConfigRoutes, {
    projectRoot: projectRoot,
    countActiveRuns: () => runStore.list().filter((run) => isActiveRunStatus(run.status)).length,
    onPortChange: opts.onPortChange,
  })
}
