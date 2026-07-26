import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../shared/run-state'
import { runsRoutes, type ExternalHealAgentRequest } from '../../features/runs/routes/runs'
import { testsDraftRoutes, type TestsDraftRouteDeps } from '../../features/wizard/routes/tests-draft'
import { externalHealRoutes, makeExternalHealAuditLogger } from '../../features/runs/routes/external-heal'
import { createRegistry, RunStore, type OrchestratorRegistry, type OrchestratorLike, type StartRunOutcome } from '../../features/runs/logic/run-store'
import { loadBundledSabotageSkills, sabotageSkillsForFeature } from '../../features/benchmark/logic/runtime/skills'
import { flightsRoutes } from '../../features/flights/routes/flights'
import { buildFlightStageAdapters } from '../../features/flights/logic/stages/index'
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
 * Flight pipeline: the conducted end-to-end run from bare repo to evaluation export. Stage adapters drive runs/portify/evaluation through their own HTTP routes, so admission, collision and store wiring stay in one place.
 *
 * Body lifted verbatim out of createServer — only the enclosing function and the
 * context destructuring below are new.
 */
export async function register(app: FastifyInstance, ctx: ServerContext) {
  const { projectRoot, featuresDir, logsDir, flightStore, planStore, workspaceEvents } = ctx

  await app.register(flightsRoutes, {
    featuresDir,
    logsDir,
    projectRoot: projectRoot,
    flightStore,
    planStore,
    workspaceEvents,
    adapters: buildFlightStageAdapters({
      featuresDir,
      logsDir,
      projectRoot: projectRoot,
      workspaceEvents,
      // Same-process HTTP reuse: stage adapters drive runs/portify/evaluation
      // through their routes (admission, collision, store wiring live there).
      inject: async (o) => {
        const resp = await app.inject({
          method: o.method,
          url: o.url,
          ...(o.payload !== undefined ? { payload: o.payload as Record<string, unknown> } : {}),
        })
        return { statusCode: resp.statusCode, json: () => resp.json() as unknown }
      },
    }),
  })
}
