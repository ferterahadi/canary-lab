import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../shared/run-state'
import { runsRoutes } from '../runs/routes/runs'
import type { ExternalHealAgentRequest } from '../runs/routes/runs-route-support'
import { evaluationRoutes } from './routes/evaluation'
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
