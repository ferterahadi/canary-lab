import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../shared/run-state'
import { runsRoutes, type ExternalHealAgentRequest } from '../../features/runs/routes/runs'
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
import { generateRunId } from '../../features/runs/logic/runtime/run-id'
import { runDirFor, buildRunPaths } from '../../features/runs/logic/runtime/run-paths'
import { RunOrchestrator, collectPortSlots, buildServiceSpecs, buildQueuedServiceEntries } from '../../features/runs/logic/runtime/orchestrator'
import { RunScheduler, type SchedulerActiveRun } from '../../features/runs/logic/runtime/run-scheduler'
import { estimateRunCost, resolveAdmissionConfig, readSystemResources } from '../../features/runs/logic/runtime/admission'
import { detectRepoCollision, normalizeRepoPaths } from '../../features/runs/logic/runtime/repo-collision'
import { addWorktree, hydrateWorkingTreeDiff, linkNodeModules, type WorktreeHandle } from '../../features/runs/logic/runtime/repo-worktree'
import {
  pickAvailableHealAgent,
} from '../../features/runs/logic/runtime/auto-heal'
import { loadProjectConfig } from '../../features/runs/logic/runtime/launcher/project-config'
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
 * Test authoring: the draft pipeline and the plan/spec agent spawns behind it. Production picks a real agent from project settings; tests inject `testsDraftDepsOverride`.
 *
 * Body lifted verbatim out of createServer — only the enclosing function and the
 * context destructuring below are new.
 */
export async function register(app: FastifyInstance, ctx: ServerContext) {
  const opts = ctx.options
  const { projectRoot, logsDir, workspaceEvents, wizardAgents } = ctx


  // Wizard route deps. Production: real claude -p via node-pty + on-demand
  const productionTestsDraftDeps: TestsDraftRouteDeps = {
    logsDir,
    projectRoot: projectRoot,
    workspaceEvents,
    newDraftId: () => generateRunId(),
    pickAgent: () => {
      const projectConfig = loadProjectConfig(projectRoot)
      if (projectConfig.healAgent === 'manual') {
        return {
          ok: false,
          error: 'Add Test generation requires Claude, Codex, or Auto. Project settings are currently set to Manual.',
        }
      }
      const agent = projectConfig.healAgent === 'auto'
        ? pickAvailableHealAgent()
        : pickAvailableHealAgent(projectConfig.healAgent)
      if (!agent) {
        return {
          ok: false,
          error: 'No configured wizard agent is available on PATH. Choose Auto, Claude, or Codex in settings and install the matching CLI.',
        }
      }
      return { ok: true, agent }
    },
    spawnPlanAgent: (input) => makePlanAgentSpawner({ registry: wizardAgents })(input),
    spawnSpecAgent: (input) => makeSpecAgentSpawner({ registry: wizardAgents })(input),
    cancelGeneration: (draftId: string) => wizardAgents.cancel(draftId),
  }

  const testsDraftDeps: TestsDraftRouteDeps = {
    ...productionTestsDraftDeps,
    ...(opts.testsDraftDepsOverride ?? {}),
  }
  await app.register(testsDraftRoutes, testsDraftDeps)
}
