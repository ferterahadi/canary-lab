import { pickConfiguredHealAgent } from './pick-heal-agent'
// Restarting a LOCAL (PTY) heal agent on a terminal run: rebuild the
// orchestrator, re-attach the streams, and hand the user's guidance to the fresh
// agent. Split out of index.ts, where it was a closure inside `register`; both
// the runs route (agent-input → restartHeal) and the external-heal handoff call
// it, so it always needed to be shared.
import path from 'path'
import { isRestartableRunStatus } from '../../../../../shared/run-state'
import { allocateRunPorts, applyFeatureEnvset } from './logic/runtime/run-primitives'
import type { ServerContext } from '../../server-context'
import { loadFeatures } from '../../shared/feature-loader'
import { runDirFor, buildRunPaths } from './logic/runtime/run-paths'
import { RunOrchestrator } from './logic/runtime/orchestrator'
import { buildAgentSpawnCommand, buildOrchestratorHealPrompt } from './logic/runtime/auto-heal'
import { loadProjectConfig } from './logic/runtime/launcher/project-config'
import { collectRepoBranchSnapshots, validateConfiguredRepoBranches } from '../../shared/git-repo'
import { RunnerLog } from './logic/runtime/runner-log'
import {
  restore,
} from './logic/runtime/env-switcher/switch'
import type { BackupRecord } from './logic/runtime/env-switcher/types'
import type { makeAttachRunStreams } from './run-stream-wiring'

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
  async function restartLocalHealClosure(runId: string, text: string): Promise<{ ok: true } | { ok: false; reason: 'run-not-found' | 'not-restartable' | 'manual-mode' | 'spawn-failed' }> {
      const detail = runStore.get(runId)
      if (!detail) return { ok: false, reason: 'run-not-found' as const }
      const manifest = detail.manifest
      if ((manifest.executionType ?? 'run') === 'verify') return { ok: false, reason: 'not-restartable' as const }
      if (!isRestartableRunStatus(manifest.status)) return { ok: false, reason: 'not-restartable' as const }
      if (manifest.healMode === 'manual') return { ok: false, reason: 'manual-mode' as const }

      const features = loadFeatures(featuresDir)
      const feature = features.find((f) => f.name === manifest.feature)
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

      const env = manifest.env ?? feature.envs?.[0]
      if (!manifest.env && env) {
        runnerLog.warn(`Restarting heal for legacy run without persisted env; defaulting to "${env}".`)
      }
      const portMap = await allocateRunPorts(feature, env)
      let backups: BackupRecord[] | null = null
      if (env) {
        try {
          backups = applyFeatureEnvset(feature.featureDir, env, portMap)
          if (backups) runnerLog.info(`Applied envset "${env}" for restarted heal ${feature.name}`)
        } catch (err) {
          runnerLog.warn(`envset apply failed: ${(err as Error).message}`)
          return { ok: false, reason: 'spawn-failed' as const }
        }
      }

      let repoBranchSnapshots
      try {
        await validateConfiguredRepoBranches(feature)
        repoBranchSnapshots = await collectRepoBranchSnapshots(feature)
      } catch (err) {
        if (backups) restore(backups)
        runnerLog.warn(`Heal restart rejected: ${(err as Error).message}`)
        return { ok: false, reason: 'not-restartable' as const }
      }

      let orch: RunOrchestrator
      try {
        orch = new RunOrchestrator({
          feature,
          env,
          runId,
          runDir,
          portMap,
	          ptyFactory,
          runnerLog,
          autoHeal: {
            agent: agentChoice,
            buildSpawnCommand: ({ sessionId, resume, mcpOutputDir, promptFile }) => buildAgentSpawnCommand(agentChoice, {
              sessionId,
              resume,
              mcpOutputDir,
              mcpConfigFile: path.join(runDir, 'mcp-config.json'),
              promptFile,
            }),
            buildCyclePrompt: buildOrchestratorHealPrompt({
              agent: agentChoice,
              projectRoot: projectRoot,
              runDir,
              personalWikiPath: projectConfig.personalWikiPath,
            }),
          },
          repoBranchSnapshots,
          initialHealCycles: manifest.healCycles,
          runStateSink: runStore,
          dirtySpecHooks: dirtySpecStore,
        })
      } catch (err) {
        if (backups) restore(backups)
        runnerLog.warn(`Heal restart failed: ${(err as Error).message}`)
        return { ok: false, reason: 'spawn-failed' as const }
      }

      attachRunStreams(orch, runnerLog, feature.name, backups)
      const broker = brokers.get(runId)!
      // Clear the previous heal session's pane buffer (and signal live
      // subscribers via `reset`) so the new REPL streams into an empty
      // pane instead of below the dead-agent transcript. The transcript
      // file itself is also truncated below.
      broker.resetPane('agent')
      broker.push('agent', `\n[orchestrator] Restarting heal with ${agentChoice}...\n`)
      registry.set(runId, orch)
      orch.restartHealFromFailure(text)
        .then(async (status) => {
          await orch.stop(status).catch(() => {})
          registry.delete(orch.runId)
        })
        .catch(async (err) => {
          broker.push('agent', `\n[orchestrator error] ${String(err)}\n`)
          await orch.stop('aborted').catch(() => {})
          registry.delete(orch.runId)
        })
      return { ok: true as const }
  }

  return restartLocalHealClosure
}
