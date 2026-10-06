import { checkRestartEligibility } from './logic/restart-eligibility'
import { prepareRestartResources } from './logic/restart-preparation'
import { createRestartedOrchestrator } from './logic/restart-orchestrator'
import { pickConfiguredHealAgent } from './pick-heal-agent'
// Restarting a LOCAL (PTY) heal agent on a terminal run: rebuild the
// orchestrator, re-attach the streams, and hand the user's guidance to the fresh
// agent. Split out of index.ts, where it was a closure inside `register`; both
// the runs route (agent-input → restartHeal) and the external-heal handoff call
// it, so it always needed to be shared.
import path from 'path'
import type { ServerContext } from '../../server-context'
import { findFeature } from '../../shared/feature-loader'
import { runDirFor, buildRunPaths } from './logic/runtime/run-paths'
import { buildOrchestratorHealPrompt } from './logic/runtime/auto-heal'
import { makeAgentSpawnCommandBuilder } from './logic/runtime/heal-agent-spawn'
import { reuseRunModelPlan } from './logic/runtime/run-model-plan'
import { loadProjectConfig } from './logic/runtime/launcher/project-config'
import { RunnerLog } from './logic/runtime/runner-log'
import type { AutoHealConfig } from './logic/runtime/run-orchestrator-types'
import { restore } from './logic/runtime/env-switcher/switch'
import type { makeAttachRunStreams } from './run-stream-wiring'
import { settleOrchestratorRun } from './logic/settle-run'

export function makeRestartLocalHeal(
  ctx: ServerContext,
  attachRunStreams: ReturnType<typeof makeAttachRunStreams>,
) {
  const {
    projectRoot,
    featuresDir,
    logsDir,
    registry,
    runStore,
    benchmarkStore,
    dirtySpecStore,
    workspaceEvents,
    externalHealBroker,
    brokers,
    activeEnvsets,
    ptyFactory,
  } = ctx
  // both runs (agent-input → restartHeal) and external-heal (handoff) paths
  // can share the same orchestrator-construction code without duplicating it.
  // The function body matches the previous inline definition exactly.
  async function restartLocalHealClosure(runId: string, text: string): Promise<{ ok: true } | { ok: false; reason: 'run-not-found' | 'not-restartable' | 'new-run-required' | 'manual-mode' | 'spawn-failed' }> {
      const detail = runStore.get(runId)
      if (!detail) return { ok: false, reason: 'run-not-found' as const }
      const manifest = detail.manifest
      const eligibility = checkRestartEligibility(manifest, runDirFor(logsDir, runId), 'heal')
      if (!eligibility.ok) return eligibility
      if (manifest.healMode === 'manual') return { ok: false, reason: 'manual-mode' as const }

      const feature = findFeature(featuresDir, manifest.feature)
      if (!feature) return { ok: false, reason: 'not-restartable' as const }

      const runDir = runDirFor(logsDir, runId)
      const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)
      const projectConfig = loadProjectConfig(projectRoot)
      if (!manifest.healAgent && projectConfig.healAgent === 'manual') {
        runnerLog.info('Heal restart rejected: project config is set to "manual".')
        return { ok: false, reason: 'manual-mode' as const }
      }
      const agentChoice = pickConfiguredHealAgent(projectConfig.healAgent, manifest.healAgent)
      if (!agentChoice) {
        runnerLog.warn('Heal restart failed: no `claude` or `codex` CLI on PATH.')
        return { ok: false, reason: 'spawn-failed' as const }
      }
      // Same lock as a full run restart: keep the persisted plan when the
      // agent is unchanged; re-resolve only when it isn't (or never was).
      const models = reuseRunModelPlan(agentChoice, manifest, projectConfig.agentModels)

      const env = manifest.env ?? feature.envs?.[0]
      if (!manifest.env && env) {
        runnerLog.warn(`Restarting heal for legacy run without persisted env; defaulting to "${env}".`)
      }
      const prepared = await prepareRestartResources({
        feature, env, runnerLog,
        envsetAppliedMessage: `Applied envset "${env}" for restarted heal ${feature.name}`,
      })
      if (!prepared.ok) {
        if (prepared.stage === 'envset') {
          runnerLog.warn(`envset apply failed: ${(prepared.error as Error).message}`)
          return { ok: false, reason: 'spawn-failed' as const }
        }
        runnerLog.warn(`Heal restart rejected: ${(prepared.error as Error).message}`)
        return { ok: false, reason: 'not-restartable' as const }
      }
      let autoHeal: AutoHealConfig
      try {
        autoHeal = {
          agent: agentChoice,
          buildSpawnCommand: makeAgentSpawnCommandBuilder(agentChoice, {
            mcpConfigFile: path.join(runDir, 'mcp-config.json'),
            models: models.heal,
          }),
          buildCyclePrompt: buildOrchestratorHealPrompt({
            agent: agentChoice,
            projectRoot,
            runDir,
            personalWikiPath: projectConfig.personalWikiPath,
          }),
        }
      } catch (err) {
        // Local healing cannot launch without its prompt; retesting can still
        // proceed without auto-heal, so this policy stays with the caller.
        if (prepared.backups) restore(prepared.backups)
        runnerLog.warn(`Heal restart failed: ${(err as Error).message}`)
        return { ok: false, reason: 'spawn-failed' as const }
      }
      const restarted = createRestartedOrchestrator({
        feature, env, runId, runDir,
        initialHealCycles: manifest.healCycles,
        resources: prepared,
        ptyFactory, runnerLog,
        runStateSink: runStore,
        dirtySpecHooks: dirtySpecStore,
        attachRunStreams,
        failureLogPrefix: 'Heal restart failed',
        modeOptions: { autoHeal, models },
      })
      if (!restarted.ok) return restarted
      const { orch } = restarted
      const broker = brokers.get(runId)!
      // Clear the previous heal session's pane buffer (and signal live
      // subscribers via `reset`) so the new REPL streams into an empty
      // pane instead of below the dead-agent transcript. The transcript
      // file itself is also truncated below.
      broker.resetPane('agent')
      broker.push('agent', `\n[orchestrator] Restarting heal with ${agentChoice}...\n`)
      registry.set(runId, orch)
      void settleOrchestratorRun(orch.restartHealFromFailure(text), { orch, registry, broker, runnerLog })
      return { ok: true as const }
  }

  return restartLocalHealClosure
}
