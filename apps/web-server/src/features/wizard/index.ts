import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../shared/run-state'
import { runsRoutes } from '../runs/routes/runs'
import type { ExternalHealAgentRequest } from '../runs/routes/runs-route-support'
import { testsDraftRoutes, type TestsDraftRouteDeps } from './routes/tests-draft'
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
import { generateRunId } from '../runs/logic/runtime/run-id'
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
import { pickAvailableHealAgent } from '../runs/logic/runtime/heal-agent-spawn'
import { loadProjectConfig } from '../runs/logic/runtime/launcher/project-config'
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
 * Test authoring: the draft pipeline and the plan/spec agent spawns behind it. Production picks a real agent from project settings; tests inject `testsDraftDepsOverride`.
 *
 * Body lifted verbatim out of createServer — only the enclosing function and the
 * context destructuring below are new.
 */
export async function register(app: FastifyInstance, ctx: ServerContext) {
  const opts = ctx.options
  const { projectRoot, logsDir, workspaceEvents } = ctx

  // Draft routes are read/track-only: every draft is authored by an external
  // MCP client, so there is no agent to pick and none to spawn.
  const testsDraftDeps: TestsDraftRouteDeps = {
    logsDir,
    projectRoot,
    workspaceEvents,
    ...(opts.testsDraftDepsOverride ?? {}),
  }
  await app.register(testsDraftRoutes, testsDraftDeps)
}
