import { renameRunFeature } from '../../runs/logic/run-store'
import { renameEvaluationExportFeature } from '../../evaluation/logic/evaluation-export-store'
import { renameDraftFeature } from '../../wizard/logic/draft-store'

// A suite's NAME is its identity: `loadFeatures` keys every feature by the
// `name` in feature.config, and every record ever written against that suite —
// flights, runs, coverage jobs, portify workflows, benchmarks, dirty-spec
// baselines, evaluation exports, wizard drafts — stamps that same string.
//
// So renaming a suite is never a one-file edit. Change `name` alone and the
// history orphans behind a name nothing resolves any more: the flight row still
// lists (keyed by the old name) while the suite lists separately under the new
// one, looking like two disconnected things. This module is the one place that
// carries a rename across every store, so the two can't drift apart again.
//
// Guarded, not best-effort: a rename underneath live work would re-home records
// the running orchestrator/conductor still holds by the old name, so callers
// must refuse while anything is active (see `activeWork`).

/** Any store that stamps the feature name on its records. */
export interface RenamableRecordStore {
  renameFeature(from: string, to: string): number
}

export interface FeatureRenameDeps {
  logsDir: string
  /** The file-backed stores to carry the rename into. */
  stores: RenamableRecordStore[]
  /** Why a rename can't proceed right now (a running flight/run), or null when
   *  nothing live holds the old name. */
  activeWork?: (feature: string) => string | null
}

export interface FeatureRenameResult {
  /** Set when the rename was refused; nothing was written. */
  error?: string
  /** How many records moved across every store. */
  moved: number
}

export function renameFeatureRecords(
  from: string,
  to: string,
  deps: FeatureRenameDeps,
): FeatureRenameResult {
  if (from === to) return { moved: 0 }
  const blocked = deps.activeWork?.(from)
  if (blocked) return { error: blocked, moved: 0 }
  let moved = 0
  for (const store of deps.stores) moved += store.renameFeature(from, to)
  moved += renameRunFeature(deps.logsDir, from, to)
  moved += renameEvaluationExportFeature(deps.logsDir, from, to)
  moved += renameDraftFeature(deps.logsDir, from, to)
  return { moved }
}
