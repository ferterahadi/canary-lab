// Wiring one live run to the workspace: the pane/runner-log/state-sink stream
// attachment, and the external-heal restart that rebuilds an orchestrator for a
// terminal run. Split out of index.ts, where both were closures inside
// `register`; the server context now arrives as an argument.
import path from 'path'
import { isRestartableRunStatus } from '../../../../../shared/run-state'
import type { ClientKind } from '../../../../../shared/run-mode'
import { type OrchestratorLike } from './logic/run-store'
import { allocateRunPorts, applyFeatureEnvset } from './logic/runtime/run-primitives'
import { PaneBroker } from './logic/pane-broker'
import { loadFeatures } from '../../shared/feature-loader'
import { runDirFor, buildRunPaths } from './logic/runtime/run-paths'
import { RunOrchestrator } from './logic/runtime/orchestrator'
import { collectRepoBranchSnapshots, validateConfiguredRepoBranches } from '../../shared/git-repo'
import { RunnerLog } from './logic/runtime/runner-log'
import {
  restore,
} from './logic/runtime/env-switcher/switch'
import type { BackupRecord } from './logic/runtime/env-switcher/types'
import type { ServerContext } from '../../server-context'

export function makeAttachRunStreams(ctx: ServerContext) {
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
  return (
  orch: RunOrchestrator,
  runnerLog: RunnerLog,
  featureName: string,
  backups: BackupRecord[] | null,
): void => {
  const runId = orch.runId
  if (backups) {
    activeEnvsets.set(runId, backups)
    orch.once('run-complete', () => {
      const records = activeEnvsets.get(runId)
      if (!records) return
      activeEnvsets.delete(runId)
      try {
        restore(records)
        runnerLog.info(`Reverted envset for ${featureName}`)
      } catch (err) {
        runnerLog.warn(`envset revert failed: ${(err as Error).message}`)
      }
    })
  }
  const broker = brokers.get(runId) ?? new PaneBroker()
  brokers.set(runId, broker)
  orch.on('service-started', ({ service }) => {
    broker.resetPane(`service:${service.safeName}`)
  })
  orch.on('service-output', ({ service, chunk }) => {
    broker.push(`service:${service.safeName}`, chunk)
  })
  orch.on('service-exit', ({ service, exitCode }) => {
    broker.markExit(`service:${service.safeName}`, exitCode)
  })
  orch.on('playwright-started', () => {
    broker.resetPane('playwright')
  })
  orch.on('playwright-output', ({ chunk }) => {
    broker.push('playwright', chunk)
  })
  orch.on('playwright-exit', ({ exitCode }) => {
    broker.markExit('playwright', exitCode)
  })
  orch.on('agent-started', ({ redirect }) => {
    if (!redirect) broker.resetPane('agent')
  })
  orch.on('agent-output', ({ chunk }) => {
    broker.push('agent', chunk)
  })
  orch.on('agent-exit', ({ exitCode }) => {
    broker.markExit('agent', exitCode)
  })
}
}

export function makeRestartExternalRun(
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
  return async (
  runId: string,
  healAgentReq: { kind: 'external'; sessionId: string; clientKind: ClientKind; clientVersion?: string; conversationName?: string; claimable?: boolean },
  guidance?: string,
): Promise<OrchestratorLike> => {
  // `claimable === false` means an external client *triggered* the restart but
  // may not own the heal loop (CLI / 'other'). The run still re-enters external
  // mode and waits for a Desktop/UI drive — it just gets no session + no broker
  // claim, so nothing spawns a local auto-heal agent behind the user's back.
  const canClaim = healAgentReq.claimable !== false
  const detail = runStore.get(runId)
  if (!detail) throw Object.assign(new Error('run-not-found'), { statusCode: 404 })
  const manifest = detail.manifest
  if (!isRestartableRunStatus(manifest.status)) throw Object.assign(new Error('not-restartable'), { statusCode: 409 })

  const features = loadFeatures(featuresDir)
  const feature = features.find((f) => f.name === manifest.feature)
  if (!feature) throw Object.assign(new Error('feature not found'), { statusCode: 404 })

  const env = manifest.env ?? feature.envs?.[0]
  const runDir = runDirFor(logsDir, runId)
  const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)

  const portMap = await allocateRunPorts(feature, env)
  let backups: BackupRecord[] | null = null
  if (env) {
    try {
      backups = applyFeatureEnvset(feature.featureDir, env, portMap)
      if (backups) runnerLog.info(`Applied envset "${env}" for external restart ${feature.name}`)
    } catch (err) {
      runnerLog.warn(`envset apply failed: ${(err as Error).message}`)
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode: 500 })
    }
  }

  let repoBranchSnapshots
  try {
    await validateConfiguredRepoBranches(feature)
    repoBranchSnapshots = await collectRepoBranchSnapshots(feature)
  } catch (err) {
    if (backups) restore(backups)
    runnerLog.warn(`External restart rejected: ${(err as Error).message}`)
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode: 409 })
  }

  const nowIso = new Date().toISOString()
  const externalHealSession: import('./logic/runtime/manifest').ExternalHealSession | undefined = canClaim
    ? {
        sessionId: healAgentReq.sessionId,
        clientKind: healAgentReq.clientKind,
        ...(healAgentReq.clientVersion ? { clientVersion: healAgentReq.clientVersion } : {}),
        ...(healAgentReq.conversationName ? { conversationName: healAgentReq.conversationName } : {}),
        claimedAt: nowIso,
        lastHeartbeatAt: nowIso,
        status: 'connected',
        cycleCount: 0,
      }
    : undefined

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
      externalHeal: true,
      externalHealSession,
      repoBranchSnapshots,
      initialHealCycles: manifest.healCycles,
      runStateSink: runStore,
      dirtySpecHooks: dirtySpecStore,
    })
  } catch (err) {
    if (backups) restore(backups)
    runnerLog.warn(`External restart failed: ${(err as Error).message}`)
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { statusCode: 500 })
  }

  if (canClaim) {
    externalHealBroker.claim(runId, {
      sessionId: healAgentReq.sessionId,
      clientKind: healAgentReq.clientKind,
      ...(healAgentReq.clientVersion ? { clientVersion: healAgentReq.clientVersion } : {}),
      ...(healAgentReq.conversationName ? { conversationName: healAgentReq.conversationName } : {}),
    })
  }

  attachRunStreams(orch, runnerLog, feature.name, backups)
  const broker = brokers.get(runId)!
  broker.resetPane('agent')
  broker.push('agent', `\n[orchestrator] Restarting external heal${guidance ? `: ${guidance}` : ''}\n`)
  registry.set(runId, orch)
  orch.restartTerminalRun(guidance)
    .then(async (status) => {
      await orch.stop(status).catch(() => {})
      registry.delete(orch.runId)
    })
    .catch(async (err) => {
      broker.push('agent', `\n[orchestrator error] ${String(err)}\n`)
      await orch.stop('aborted').catch(() => {})
      registry.delete(orch.runId)
    })
  return orch
}
}
