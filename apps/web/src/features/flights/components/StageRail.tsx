import type { FlightStageKey, FlightStageStatus, PrdSourceCheckpointData } from '@/shared/api/client'
import { STAGE_LABEL, stageLabel } from './stage-meta'
import { presentedStageStatus } from './stage-metrics'
import { flightRailLabel } from '@shared/flights/stage-labels'
import { FLIGHT_EXECUTION_ORDER } from '@shared/flights/types'

// ─── Rail rows (R21/R22/R32/R33) ────────────────────────────────────────────
// The rail is a lens for the USER, not a dump of the conductor's internals:
// - similarity is plumbing — visible ONLY when it needs a human (parked on the
//   similarity-choice checkpoint) or failed; a silent pass/skip never shows.
// - three stage PAIRS are one step in the user's mental model and merge into
//   one row keyed by the pair's first stage; the companion's status folds in.
//   Store/MCP/CLI keys are untouched:
//     run + heal          → "Test run"       (run my tests, repair what breaks)
//     scaffold + env-capture → "Suite setup" (create it, prove it boots)
//     docs + prd-summary  → "Requirements"   (collect docs, distill them)

export interface StageRailRow {
  key: FlightStageKey
  label: string
  status: FlightStageStatus
  /** Short qualifier shown beside the label — currently "empty" when a stage
   *  is parked because its agent came back with nothing. `waiting-for-approval`
   *  alone can't distinguish "your turn to choose" from "your turn because the
   *  agent found nothing", and those want different urgency from the rail. */
  note?: string
}

/** Pair-merged rail rows: row key → the companion stage folded into it. The
 *  companion never gets its own row; its status/evidence/checkpoint surface
 *  through the pair (StageDetail reads it via this map too). */
export const STAGE_COMPANION: Partial<Record<FlightStageKey, FlightStageKey>> = {
  'run': 'heal',
  'scaffold': 'env-capture',
  'docs': 'prd-summary',
}

/** The rail row `key` renders in — a folded companion maps back to its
 *  primary, every other stage is its own row. Anything that names a stage to
 *  the user (the resume target, a jump label) must go through this: naming the
 *  raw stage key would surface `prd-summary`, a row the rail never shows. */
export function stageRowKey(key: FlightStageKey): FlightStageKey {
  const primary = (Object.keys(STAGE_COMPANION) as FlightStageKey[]).find(
    (k) => STAGE_COMPANION[k] === key,
  )
  return primary ?? key
}

export const FOLDED_KEYS = new Set<string>(Object.values(STAGE_COMPANION))

export function mergedPairStatus(
  primary: { status: FlightStageStatus } | undefined,
  companion: { status: FlightStageStatus } | undefined,
): FlightStageStatus {
  const p = primary?.status ?? 'pending'
  const c = companion?.status ?? 'pending'
  if (p === 'running' || c === 'running') return 'running'
  if (p === 'waiting-for-approval' || c === 'waiting-for-approval') return 'waiting-for-approval'
  if (p === 'failed' || c === 'failed') return 'failed'
  // R78: a merged row is done only when BOTH halves have settled. Reporting the
  // primary alone marked Requirements ✓ done while its summary distiller had
  // not run at all (docs approved, flight paused before prd-summary) — the row
  // claimed a step was finished that the conductor will still re-enter. The
  // unsettled half wins, so the row reads exactly as far as it actually got.
  const settled = (s: FlightStageStatus) => s === 'done' || s === 'skipped'
  if (settled(p) && !settled(c)) return c
  // Both settled but disagreeing: the half that DID something speaks. Resuming
  // mid-pipeline skips `scaffold` while `env-capture` still reads its boot proof
  // off the workspace, and taking the primary alone marked Suite setup ↷ over a
  // pane full of booted services. A step where one half had nothing to do is a
  // step that happened.
  if (settled(p) && settled(c)) return p === 'done' || c === 'done' ? 'done' : p
  return p
}

/** "empty" when this stage is parked on a collector attempt that found
 *  nothing. Reads the same `lastAttempt` the fork panel uses, so the rail and
 *  the panel can never disagree. */
export function stageRailNote(stage: { key: string; checkpoint?: { data?: unknown } }): string | undefined {
  if (stage.key !== 'docs') return undefined
  const data = stage.checkpoint?.data as PrdSourceCheckpointData | undefined
  return data?.lastAttempt ? 'empty' : undefined
}

export function stageRailRows(
  stages: Array<{ key: string; status: FlightStageStatus; evidence?: unknown; checkpoint?: { kind?: string; data?: unknown } }>,
): StageRailRow[] {
  const rows: StageRailRow[] = []
  const byKey = new Map(stages.map((stage) => [stage.key, stage]))
  const knownKeys = new Set<string>(FLIGHT_EXECUTION_ORDER)
  const orderedStages = FLIGHT_EXECUTION_ORDER
    .map((key) => byKey.get(key))
    .filter((stage): stage is (typeof stages)[number] => stage != null)
  // Preserve forward compatibility with a newer server that sends an unknown
  // stage: known rows follow Flight priority; unknown rows remain visible last.
  orderedStages.push(...stages.filter((stage) => !knownKeys.has(stage.key)))

  for (const raw of orderedStages) {
    // `presented`, not `settled`: a stage parked on a hand-off to the user's own
    // agent draws as running here, so the rail (and everything downstream of it
    // — the row icon, the auto-selected stage, the stage chip) never marks live
    // work as a question waiting on the reader.
    const s = { ...raw, status: presentedStageStatus(raw) }
    const key = s.key as FlightStageKey
    if (key === 'similarity') {
      if (s.status !== 'waiting-for-approval' && s.status !== 'failed') continue
      rows.push({ key, label: s.status === 'failed' ? 'Pre-flight check' : STAGE_LABEL.similarity, status: s.status })
      continue
    }
    if (FOLDED_KEYS.has(key)) continue // folded into its pair row
    const companionKey = STAGE_COMPANION[key]
    if (companionKey) {
      const companionRaw = byKey.get(companionKey)
      const companion = companionRaw ? { ...companionRaw, status: presentedStageStatus(companionRaw) } : undefined
      // `docs` reaches the rail through here, not the plain branch below — it
      // is the primary of the docs+prd-summary pair ("Requirements").
      rows.push({
        key,
        label: flightRailLabel(key),
        status: mergedPairStatus(s, companion),
        note: stageRailNote(s),
      })
      continue
    }
    rows.push({ key, label: stageLabel(key), status: s.status, note: stageRailNote(s) })
  }
  return rows
}
