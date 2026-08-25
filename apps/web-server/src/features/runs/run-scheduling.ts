// Admission and the FIFO queue scheduler for the run loop: the resource budget,
// the active-run view the scheduler sorts on, the queued-run manifest writer and
// its cancel path. Split out of index.ts, where it was inline in `register`.
import path from 'path'
import { isActiveRunStatus } from '../../../../../shared/run-state'
import { runDirFor } from './logic/runtime/run-paths'
import { buildQueuedServiceEntries } from './logic/runtime/orchestrator'
import { RunScheduler, type SchedulerActiveRun } from './logic/runtime/run-scheduler'
import { estimateRunCost, resolveAdmissionConfig, readSystemResources } from './logic/runtime/admission'
import { normalizeRepoPaths } from './logic/runtime/repo-collision'
import type { QueueReason } from '../../../../../shared/run-state'
import type { FeatureConfig } from '../../../../../shared/launcher/types'
import type { ExecutionType } from '../../../../../shared/verification'
import type { ServerContext } from '../../server-context'

export function buildRunScheduling(ctx: ServerContext) {
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
  // Different apps run concurrently on distinct allocated ports; runs that
  // exceed the resource budget, or that decline worktree isolation against an
  // active run on the same repo, are parked here and promoted FIFO on run-end.
  const admissionConfig = resolveAdmissionConfig()
  const listActiveForScheduler = (): SchedulerActiveRun[] =>
    runStore.list()
      .filter((e) => isActiveRunStatus(e.status))
      .map((e) => {
        const detail = runStore.get(e.runId)
        return {
          runId: e.runId,
          feature: e.feature,
          repoPaths: detail?.manifest.repoPaths ?? [],
          cost: estimateRunCost(detail?.manifest.services?.length ?? 0),
        }
      })
  const scheduler = new RunScheduler({
    listActive: listActiveForScheduler,
    readResources: readSystemResources,
    config: admissionConfig,
  })
  runStore.onEvent((e) => {
    if (e.kind === 'finalized') {
      void scheduler.promote()
    }
    if (e.kind === 'journal-changed' && e.runId) {
      workspaceEvents.publish({ type: 'journal-changed', runId: e.runId })
    }
  })

  // Persist a placeholder manifest for a queued run so it shows up in the UI
  // (status 'queued' + reason) before any process is spawned. Promotion later
  // overwrites this with the real running manifest under the same runId.
  const writeQueuedManifest = (
    runId: string,
    feature: FeatureConfig,
    env: string | undefined,
    reason: QueueReason,
    executionType: ExecutionType = 'run',
  ): void => {
    const startedAt = new Date().toISOString()
    runStore.bootstrap({
      runId,
      executionType,
      feature: feature.name,
      featureDir: feature.featureDir,
      env,
      startedAt,
      status: 'queued',
      healCycles: 0,
      // Surface the services that will boot on promotion (status 'queued', no
      // ports yet) so the queued run's Overview isn't a bare "No services
      // configured". Promotion overwrites this with the real running manifest.
      services: buildQueuedServiceEntries(feature, runDirFor(logsDir, runId), env),
      repoPaths: normalizeRepoPaths((feature.repos ?? []).map((r) => r.localPath)),
      queueReason: reason,
      heartbeatAt: startedAt,
    })
  }

  // Cancel a run that's still waiting in the queue (no orchestrator yet).
  const cancelQueuedRun = (runId: string): boolean => {
    if (!scheduler.cancel(runId)) return false
    runStore.finalize(runId, 'aborted', new Date().toISOString(), 0)
    return true
  }

  return { admissionConfig, listActiveForScheduler, scheduler, writeQueuedManifest, cancelQueuedRun }
}
