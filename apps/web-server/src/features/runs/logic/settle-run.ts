// Every path that drives an orchestrator to completion — first run, retest,
// local heal restart, external heal restart — settles it the same way: stop it
// with the status it reached, and drop it from the active registry.
//
// The error arm used to write ONLY to the live agent pane. Nothing persisted,
// so a run that died before anyone opened the pane left a manifest reading
// `aborted` with an empty runner.log and no cause anywhere on disk. That is how
// a blocked `postinstall` (node-pty's spawn-helper left non-executable, every
// spawn dying with "posix_spawnp failed") presented as an unexplained abort.
// The cause now goes to the runner log too, which is persisted and is what the
// Run Logs tab reads.

import type { RunStatus } from '../../../../../../shared/run-state'

export interface SettleTarget {
  runId: string
  stop(status?: RunStatus): Promise<unknown>
}

export interface SettleDeps {
  orch: SettleTarget
  registry: { delete(runId: string): unknown }
  broker: { push(pane: 'agent', chunk: string): unknown }
  runnerLog?: { error(message: string): void } | null
}

/**
 * Attach the shared completion handling to an orchestrator's driving promise.
 * Never rejects: a failure to stop cleanly must not leave the run registered.
 */
export async function settleOrchestratorRun(
  work: Promise<RunStatus>,
  { orch, registry, broker, runnerLog }: SettleDeps,
): Promise<void> {
  try {
    const status = await work
    await orch.stop(status).catch(() => {})
  } catch (err) {
    const message = String(err)
    broker.push('agent', `\n[orchestrator error] ${message}\n`)
    runnerLog?.error(`Run failed to complete: ${message}`)
    await orch.stop('aborted').catch(() => {})
  } finally {
    registry.delete(orch.runId)
  }
}
