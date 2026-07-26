import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../shared/run-state'
import { runsRoutes, type ExternalHealAgentRequest } from '../../features/runs/routes/runs'
import { evaluationRoutes } from '../../features/evaluation/routes/evaluation'
import { testsDraftRoutes, type TestsDraftRouteDeps } from '../../features/wizard/routes/tests-draft'
import { externalHealRoutes, makeExternalHealAuditLogger } from '../../features/runs/routes/external-heal'
import { createRegistry, RunStore, type OrchestratorRegistry, type OrchestratorLike, type StartRunOutcome } from '../../features/runs/logic/run-store'
import { loadBundledSabotageSkills, sabotageSkillsForFeature } from '../../features/benchmark/logic/runtime/skills'
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
