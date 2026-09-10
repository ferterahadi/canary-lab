import type { RunStatus } from '../../../../../../../shared/run-state'
import { isTerminalRunStatus } from '../../../../../../../shared/run-state'
import type { RobustnessEnvelope } from '../../../../../../../shared/robustness/types'
import type { RunSummary } from '../run-detail'
import type { RunStore, RunStoreEvent } from '../run-store'
import type { RunsRouteDeps } from '../../routes/runs-route-deps'
import type { PlaywrightRerunSelection } from '../runtime/rerun-targets'

// One Robustness Lab cell, run through the SAME run loop every other run uses:
// `startRun` boots the suite's services under a one-atom envelope (the shim
// ports land in the envset exactly as for a perturbed run), the first Playwright
// pass is narrowed to the cell's spec file, nothing heals, and the run settles
// like any other. This module adds only what a matrix needs on top of that —
// waiting for the run to finish and handing back its verdict artefacts — so the
// runner also serves shrink, which replays a cell under smaller envelopes.

export interface RobustnessCellRequest {
  feature: string
  env?: string
  envelope: RobustnessEnvelope
  selection: PlaywrightRerunSelection
  /** Fires when the owning job is aborted: the cell's run is aborted through
   *  the run store, so it settles (as `aborted`) instead of running to the end
   *  for a matrix nobody will read. */
  signal?: AbortSignal
}

export interface RobustnessCellResult {
  runId: string
  status: RunStatus
  /** The cell run's summary; absent when the run ended before Playwright wrote one. */
  summary?: RunSummary
}

export type RobustnessCellRunner = (request: RobustnessCellRequest) => Promise<RobustnessCellResult>

export interface RobustnessCellRunnerDeps {
  startRun: RunsRouteDeps['startRun']
  runStore: Pick<RunStore, 'get' | 'onEvent' | 'offEvent' | 'abort'>
}

export function makeRobustnessCellRunner(deps: RobustnessCellRunnerDeps): RobustnessCellRunner {
  return async (request) => {
    // `worktree` isolation is what a human picks at the collision prompt; a cell
    // has no human to ask, so it always takes that answer. A cell is not a
    // regular run, so the always-worktree rule does not apply and only a real
    // collision (or a portified suite) isolates it.
    const outcome = await deps.startRun(request.feature, request.env, undefined, 'worktree', 'robustness', undefined, request.envelope, request.selection)
    if (outcome.kind === 'collision') {
      throw new Error(`robustness cell for ${request.feature} could not start: another run (${outcome.conflictingFeature}, ${outcome.conflictingRunId}) holds its repos`)
    }
    const runId = outcome.kind === 'started' ? outcome.orch.runId : outcome.runId
    // Best-effort by contract: the store answers `not-active` for a run that
    // settled on its own in the meantime, and the settle wait below still ends
    // through the run's own terminal state either way.
    const abortRun = (): void => { void deps.runStore.abort(runId).catch(() => {}) }
    if (request.signal?.aborted) abortRun()
    else request.signal?.addEventListener('abort', abortRun, { once: true })
    try {
      const status = await settledStatus(deps.runStore, runId)
      return { runId, status, summary: deps.runStore.get(runId)?.summary }
    } finally {
      request.signal?.removeEventListener('abort', abortRun)
    }
  }
}

/** Resolves with the run's terminal status. Subscribes before the first read so
 *  a run that settles between the two is still seen. */
function settledStatus(runStore: RobustnessCellRunnerDeps['runStore'], runId: string): Promise<RunStatus> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      const status = runStore.get(runId)?.manifest.status
      if (!isTerminalRunStatus(status)) return false
      runStore.offEvent(listener)
      resolve(status)
      return true
    }
    const listener = (event: RunStoreEvent) => {
      if (event.runId === runId) check()
    }
    runStore.onEvent(listener)
    check()
  })
}
