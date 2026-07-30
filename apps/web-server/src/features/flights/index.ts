import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../shared/run-state'
import { runsRoutes, type ExternalHealAgentRequest } from '../runs/routes/runs'
import { testsDraftRoutes, type TestsDraftRouteDeps } from '../wizard/routes/tests-draft'
import { externalHealRoutes, makeExternalHealAuditLogger } from '../runs/routes/external-heal'
import { createRegistry, RunStore, type OrchestratorRegistry, type OrchestratorLike, type StartRunOutcome } from '../runs/logic/run-store'
import { loadBundledSabotageSkills, sabotageSkillsForFeature } from '../benchmark/logic/runtime/skills'
import { flightsRoutes } from './routes/flights'
import { buildFlightStageAdapters } from './logic/stages/index'
import {
  buildAgentSessionResponse,
  resolveWorkflowAgentRef,
} from '../agent-sessions/logic/agent-session-log'
import { allocateRunPorts, applyFeatureEnvset } from '../runs/logic/runtime/run-primitives'
import type { ServerContext } from '../../server-context'
import { getInstalledPackageName, getInstalledPackageVersion } from '../../../../../shared/runtime/upgrade-check'
import { runDirFor, buildRunPaths } from '../runs/logic/runtime/run-paths'
import { RunOrchestrator, collectPortSlots, buildServiceSpecs, buildQueuedServiceEntries } from '../runs/logic/runtime/orchestrator'
import { RunScheduler, type SchedulerActiveRun } from '../runs/logic/runtime/run-scheduler'
import { estimateRunCost, resolveAdmissionConfig, readSystemResources } from '../runs/logic/runtime/admission'
import { detectRepoCollision, normalizeRepoPaths } from '../runs/logic/runtime/repo-collision'
import { addWorktree, hydrateWorkingTreeDiff, linkNodeModules, type WorktreeHandle } from '../runs/logic/runtime/repo-worktree'
import {
  buildAgentSpawnCommand,
  buildOrchestratorHealPrompt,
  pickAvailableHealAgent,
  resolveAgentBinary,
  type BuildHealCyclePrompt,
  type HealAgent,
} from '../runs/logic/runtime/auto-heal'
import { collectRepoBranchSnapshots, validateConfiguredRepoBranches } from '../../shared/git-repo'
import { realPtyFactory, type PtyFactory } from '../runs/logic/runtime/pty-spawner'
import {
  applySet,
  backup,
  getEnvSetsDir,
  loadConfig,
  resolveVars,
  restore,
} from '../runs/logic/runtime/env-switcher/switch'
import {
  buildVerificationDiagnostics,
  resolveVerificationRun,
  type ResolveVerificationInput,
} from '../coverage/logic/verification'

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
