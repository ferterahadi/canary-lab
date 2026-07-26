import type { RunsFeature } from '../runs/index'
import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../shared/run-state'
import { runsRoutes, type ExternalHealAgentRequest } from '../runs/routes/runs'
import { testsDraftRoutes, type TestsDraftRouteDeps } from '../wizard/routes/tests-draft'
import { externalHealRoutes, makeExternalHealAuditLogger } from '../runs/routes/external-heal'
import { createRegistry, RunStore, type OrchestratorRegistry, type OrchestratorLike, type StartRunOutcome } from '../runs/logic/run-store'
import { benchmarkRoutes } from './routes/benchmarks'
import { benchmarkStreamRoutes } from './ws/benchmark-stream'
import { createBenchmarkRunner } from './logic/runtime/runner'
import { loadBundledSabotageSkills, sabotageSkillsForFeature } from './logic/runtime/skills'
import { benchmarkDir } from './logic/runtime/paths'
import {
  buildAgentSessionResponse,
  resolveWorkflowAgentRef,
} from '../agent-sessions/logic/agent-session-log'
import { allocateRunPorts, applyFeatureEnvset } from '../runs/logic/runtime/run-primitives'
import type { ServerContext } from '../../server-context'
import { getInstalledPackageName, getInstalledPackageVersion } from '../../../../../shared/runtime/upgrade-check'
import { loadFeatures } from '../../shared/feature-loader'
import {
  spawnPlanAgent as makePlanAgentSpawner,
  spawnSpecAgent as makeSpecAgentSpawner,
} from '../wizard/logic/wizard-agent-runner'
import { runDirFor, buildRunPaths } from '../runs/logic/runtime/run-paths'
import { RunOrchestrator, collectPortSlots, buildServiceSpecs, buildQueuedServiceEntries } from '../runs/logic/runtime/orchestrator'
import { RunScheduler, type SchedulerActiveRun } from '../runs/logic/runtime/run-scheduler'
import { estimateRunCost, resolveAdmissionConfig, readSystemResources } from '../runs/logic/runtime/admission'
import { detectRepoCollision, normalizeRepoPaths } from '../runs/logic/runtime/repo-collision'
import { addWorktree, hydrateWorkingTreeDiff, linkNodeModules, type WorktreeHandle } from '../runs/logic/runtime/repo-worktree'
import {
  pickAvailableHealAgent,
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
 * Benchmark: race two repair arms on a sabotaged codebase. Closes over the same run primitives startRun uses, which is why it takes them from the runs handle.
 *
 * Body lifted verbatim out of createServer — only the enclosing function and the
 * context destructuring below are new.
 */
export async function register(app: FastifyInstance, ctx: ServerContext, runs: RunsFeature) {
  const { scheduler, attachRunStreams } = runs
  const { projectRoot, featuresDir, logsDir, registry, runStore, benchmarkStore, ptyFactory } = ctx

  // Benchmark: race two repair arms on a sabotaged codebase. The runner closes
  // over the same primitives startRun uses (ptyFactory, registry, attachRunStreams).
  const benchmarkRunner = createBenchmarkRunner({
    projectRoot: projectRoot,
    logsDir,
    store: benchmarkStore,
    ptyFactory,
    runStore,
    registry,
    scheduler,
    attachRunStreams,
    allocateRunPorts,
    applyFeatureEnvset,
    loadFeatures: () => loadFeatures(featuresDir),
    // Benchmark pins its own agent (per-run choice), NOT the project's global
    // heal-agent setting — keeps a benchmark reproducible + always local-auto.
    pickAgent: (preferred) => pickAvailableHealAgent(preferred),
    now: () => new Date().toISOString(),
  })
  await app.register(benchmarkRoutes, {
    store: benchmarkStore,
    logsDir,
    featuresDir,
    projectRoot: projectRoot,
    startBenchmark: benchmarkRunner.startBenchmark,
    abortBenchmark: benchmarkRunner.abort,
    loadAgentSession: (id) => {
      const ref = resolveWorkflowAgentRef(benchmarkDir(logsDir, id))
      return ref ? buildAgentSessionResponse(ref) : null
    },
    listSkills: (feature) => sabotageSkillsForFeature(loadBundledSabotageSkills(), feature),
  })
  await app.register(benchmarkStreamRoutes, { store: benchmarkStore })
}
