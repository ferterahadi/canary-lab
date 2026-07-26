import type { RunsFeature } from '../runs'
import type { FastifyInstance } from 'fastify'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../shared/run-state'
import { runsRoutes, type ExternalHealAgentRequest } from '../../features/runs/routes/runs'
import { testsDraftRoutes, type TestsDraftRouteDeps } from '../../features/wizard/routes/tests-draft'
import { externalHealRoutes, makeExternalHealAuditLogger } from '../../features/runs/routes/external-heal'
import { createRegistry, RunStore, type OrchestratorRegistry, type OrchestratorLike, type StartRunOutcome } from '../../features/runs/logic/run-store'
import { benchmarkRoutes } from '../../features/benchmark/routes/benchmarks'
import { benchmarkStreamRoutes } from '../../features/benchmark/ws/benchmark-stream'
import { createBenchmarkRunner } from '../../features/benchmark/logic/runtime/runner'
import { loadBundledSabotageSkills, sabotageSkillsForFeature } from '../../features/benchmark/logic/runtime/skills'
import { benchmarkDir } from '../../features/benchmark/logic/runtime/paths'
import {
  buildAgentSessionResponse,
  resolveWorkflowAgentRef,
} from '../../features/agent-sessions/logic/agent-session-log'
import { allocateRunPorts, applyFeatureEnvset } from '../runs/logic/runtime/run-primitives'
import type { ServerContext } from '../../server-context'
import { getInstalledPackageName, getInstalledPackageVersion } from '../../../../../shared/runtime/upgrade-check'
import { loadFeatures } from '../../features/config/logic/feature-loader'
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
  pickAvailableHealAgent,
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
