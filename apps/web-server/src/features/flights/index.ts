import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../shared/run-state'
import { runsRoutes } from '../runs/routes/runs'
import type { ExternalHealAgentRequest } from '../runs/routes/runs-route-support'
import { testsDraftRoutes, type TestsDraftRouteDeps } from '../wizard/routes/tests-draft'
import { externalHealRoutes, makeExternalHealAuditLogger } from '../runs/routes/external-heal'
import { RunStore } from '../runs/logic/run-store'
import {
  createRegistry,
  type OrchestratorRegistry,
  type OrchestratorLike,
  type StartRunOutcome,
} from '../runs/logic/run-registry'
import { loadBundledSabotageSkills, sabotageSkillsForFeature } from '../benchmark/logic/runtime/skills'
import { flightsRoutes } from './routes/flights'
import { flightsStreamRoutes } from './ws/flights-stream'
import { buildFlightStageAdapters } from './logic/stages/index'
import { resolveWorkflowAgentRef } from '../agent-sessions/logic/agent-session-log'
import { buildAgentSessionResponse } from '../agent-sessions/logic/agent-session-subagents'
import { allocateRunPorts, applyFeatureEnvset } from '../runs/logic/runtime/run-primitives'
import type { ServerContext } from '../../server-context'
import { getInstalledPackageName, getInstalledPackageVersion } from '../../../../../shared/runtime/upgrade-check'
import { runDirFor, buildRunPaths } from '../runs/logic/runtime/run-paths'
import { RunOrchestrator } from '../runs/logic/runtime/orchestrator'
import {
  collectPortSlots,
  buildServiceSpecs,
  buildQueuedServiceEntries,
} from '../runs/logic/runtime/service-specs'
import { RunScheduler, type SchedulerActiveRun } from '../runs/logic/runtime/run-scheduler'
import { estimateRunCost, resolveAdmissionConfig, readSystemResources } from '../runs/logic/runtime/admission'
import { detectRepoCollision, normalizeRepoPaths } from '../runs/logic/runtime/repo-collision'
import { addWorktree, hydrateWorkingTreeDiff, linkNodeModules, type WorktreeHandle } from '../runs/logic/runtime/repo-worktree'
import { buildOrchestratorHealPrompt, type BuildHealCyclePrompt } from '../runs/logic/runtime/auto-heal'
import { buildAgentSpawnCommand, pickAvailableHealAgent } from '../runs/logic/runtime/heal-agent-spawn'
import { resolveAgentBinary, type HealAgent } from '../agent-sessions/logic/agent-binary'
import { collectRepoBranchSnapshots, validateConfiguredRepoBranches } from '../../shared/git-repo'
import { realPtyFactory, type PtyFactory } from '../runs/logic/runtime/pty-spawner'
import { applySet, backup, restore } from '../runs/logic/runtime/env-switcher/switch'
import { getEnvSetsDir, loadConfig, resolveVars } from '../config/logic/envset-runtime'
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
    gettingStarted: ctx.gettingStarted,
    repositoryObserver: ctx.repositoryObserver,
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

  // The push channel for the same store the routes above write. Registered
  // after them so the store is already bridged to the workspace bus — the two
  // are complements, not alternatives: the bus tells every surface "flights
  // moved", this one carries the manifest to whoever is watching.
  await app.register(flightsStreamRoutes, { store: flightStore })
}
