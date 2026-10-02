import type { RunsFeature } from '../runs/index'
import type { FastifyInstance } from 'fastify'

import { benchmarkRoutes } from './routes/benchmarks'
import { benchmarkStreamRoutes } from './ws/benchmark-stream'
import { createBenchmarkRunner } from './logic/runtime/runner'
import { loadBundledSabotageSkills, sabotageSkillsForFeature } from './logic/runtime/skills'
import { benchmarkDir } from './logic/runtime/paths'
import { resolveWorkflowAgentRef } from '../agent-sessions/logic/agent-session-log'
import { buildAgentSessionResponse } from '../agent-sessions/logic/agent-session-subagents'
import { allocateRunPorts, applyFeatureEnvset } from '../runs/logic/runtime/run-primitives'
import type { ServerContext } from '../../server-context'

import { loadFeatures } from '../../shared/feature-loader'

import { pickAvailableHealAgent } from '../runs/logic/runtime/heal-agent-spawn'

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
