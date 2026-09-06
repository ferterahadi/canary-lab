import type { DirtySpecStore } from '../dirty-specs/store'
import type { OrchestratorRegistry } from '../run-registry'

/** Every dirty-spec change re-measures the pending edits of the runs active on
 *  that feature. The registry holds every live orchestrator; each decides for
 *  itself whether the feature is its own and whether Playwright is mid-run
 *  (`refreshSpecEdits`). A removed record (`featureId` absent) names no
 *  feature and changes nothing a run measures. */
export function bridgeDirtySpecsToActiveRuns(store: Pick<DirtySpecStore, 'onEvent'>, registry: Pick<OrchestratorRegistry, 'list'>): void {
  store.onEvent((e) => {
    if (!e.featureId) return
    for (const orch of registry.list()) orch.refreshSpecEdits?.(e.featureId)
  })
}
