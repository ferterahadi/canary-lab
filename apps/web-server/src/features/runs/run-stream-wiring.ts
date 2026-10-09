import { prepareRestartResources } from './logic/restart-preparation'
import { createExternalHealSession, projectExternalHealMetadata } from './logic/heal/external-heal-session'
// Wiring one live run to the workspace: the pane/runner-log/state-sink stream
// attachment, and the external-heal restart that rebuilds an orchestrator for a
// terminal run. Split out of index.ts, where both were closures inside
// `register`; the server context now arrives as an argument.
import { isRestartableRunStatus } from '../../../../../shared/run-state'
import type { ClientKind } from '../../../../../shared/run-mode'
import type { OrchestratorLike } from './logic/run-registry'
import { hasRetiredPerturbation } from './logic/runtime/manifest'
import { PaneBroker } from './logic/pane-broker'
import { findFeature } from '../../shared/feature-loader'
import { httpFailure } from '../../shared/http-error'
import { runDirFor, buildRunPaths } from './logic/runtime/run-paths'
import { RunOrchestrator } from './logic/runtime/orchestrator'
import { RunnerLog } from './logic/runtime/runner-log'
import {
  restore,
} from './logic/runtime/env-switcher/switch'
import type { BackupRecord } from './logic/runtime/env-switcher/types'
import type { ServerContext } from '../../server-context'
import { settleOrchestratorRun } from './logic/settle-run'
import { startSummaryChangeWatcher } from './logic/summary-change-watcher'
import { claimedSingleAttempt, policyForRunManifest, NEW_RUN_REQUIRED_MESSAGE } from '../../shared/single-attempt'

export function makeAttachRunStreams(
  ctx: ServerContext,
  startSummaryWatcher: typeof startSummaryChangeWatcher = startSummaryChangeWatcher,
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
  return (
  orch: RunOrchestrator,
  runnerLog: RunnerLog,
  featureName: string,
  backups: BackupRecord[] | null,
): void => {
  const runId = orch.runId
  let summaryWatcher: ReturnType<typeof startSummaryChangeWatcher> | null = null
  const stopSummaryWatcher = (): void => {
    summaryWatcher?.close()
    summaryWatcher = null
  }
  orch.once('run-complete', stopSummaryWatcher)
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
    stopSummaryWatcher()
    summaryWatcher = startSummaryWatcher({
      summaryPath: buildRunPaths(runDirFor(logsDir, runId)).summaryPath,
      onChange: () => runStore.notifyDetailChanged(runId),
      onError: (error) => runnerLog.warn(`summary watcher failed: ${error.message}`),
    })
    broker.resetPane('playwright')
  })
  orch.on('playwright-output', ({ chunk }) => {
    broker.push('playwright', chunk)
  })
  orch.on('playwright-exit', ({ exitCode }) => {
    broker.markExit('playwright', exitCode)
    stopSummaryWatcher()
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
  if (hasRetiredPerturbation(manifest)) throw Object.assign(new Error('This run used a retired perturbation and cannot be restarted; start a new run.'), { statusCode: 409 })
  if (!isRestartableRunStatus(manifest.status)) throw Object.assign(new Error('not-restartable'), { statusCode: 409 })
  if (claimedSingleAttempt(runDirFor(logsDir, runId), policyForRunManifest(manifest))) {
    throw Object.assign(new Error(NEW_RUN_REQUIRED_MESSAGE), { statusCode: 409 })
  }

  const feature = findFeature(featuresDir, manifest.feature)
  if (!feature) throw Object.assign(new Error('feature not found'), { statusCode: 404 })

  const env = manifest.env ?? feature.envs?.[0]
  const runDir = runDirFor(logsDir, runId)
  const runnerLog = new RunnerLog(buildRunPaths(runDir).runnerLogPath)

  const prepared = await prepareRestartResources({
    feature, env, runnerLog,
    envsetAppliedMessage: `Applied envset "${env}" for external restart ${feature.name}`,
  })
  if (!prepared.ok) {
    if (prepared.stage === 'envset') {
      runnerLog.warn(`envset apply failed: ${(prepared.error as Error).message}`)
      throw httpFailure(prepared.error, 500)
    }
    runnerLog.warn(`External restart rejected: ${(prepared.error as Error).message}`)
    throw httpFailure(prepared.error, 409)
  }
  const { portMap, backups, repoBranchSnapshots } = prepared

  const nowIso = new Date().toISOString()
  const externalHealSession: import('../../../../../shared/run-manifest').ExternalHealSession | undefined = canClaim
    ? createExternalHealSession(healAgentReq, nowIso, 'nonempty')
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
    throw httpFailure(err, 500)
  }

  if (canClaim) {
    externalHealBroker.claim(runId, projectExternalHealMetadata(healAgentReq, 'nonempty'))
  }

  attachRunStreams(orch, runnerLog, feature.name, backups)
  const broker = brokers.get(runId)!
  broker.resetPane('agent')
  broker.push('agent', `\n[orchestrator] Restarting external heal${guidance ? `: ${guidance}` : ''}\n`)
  registry.set(runId, orch)
  void settleOrchestratorRun(orch.restartTerminalRun(guidance), { orch, registry, broker, runnerLog })
  return orch
}
}
