import { useMemo } from 'react'
import { FLIGHT_STAGE_KEYS, type FlightManifest } from '@shared/flights/types'
import type { FlightStageKey, FlightStageStatus } from '@/shared/api/client'
import type { EvaluationExportTask, Feature, RunIndexEntry } from '@/shared/api/types'
import { useEvaluationExports } from '@/features/evaluation'
import { useRuns } from '@/features/runs'

// Evidence-derived stage rail for a feature with NO flight record: what has
// actually been done to this suite, regardless of who did it (flight, wizard,
// MCP, standalone runs). The flight record stays the pipeline journal — rows
// that have one keep rendering its stages; this fills the resting flightless
// rows so real progress doesn't read as an untouched feature.
//
// Honesty rule (same spirit as the picker footer): a square lights only when
// the stage's own artifact is checkably present — merged pair cells light on
// the pair's OUTCOME (Suite setup needs the captured envset, Requirements
// needs the distilled summary), never on the cheaper half alone.

export interface DerivedStage {
  key: FlightStageKey
  status: FlightStageStatus
}

/** Status per stage from workspace evidence. Returns null when the server
 *  payload carries no evidence block (older server) — callers fall back to the
 *  all-pending rail + "not flown" chip. Full 11-key array so `stageRailRows`
 *  folds pairs exactly like a flight-record rail. */
export function deriveFeatureStages(
  feature: Pick<Feature, 'evidence' | 'portified'>,
  latestRun?: RunIndexEntry,
  hasExport?: boolean,
): DerivedStage[] | null {
  const ev = feature.evidence
  if (!ev) return null
  const runStatus: FlightStageStatus =
    latestRun?.status === 'passed' ? 'done' : latestRun?.status === 'failed' ? 'failed' : 'pending'
  const suiteSetUp = ev.envCapture || ev.booted === true
  const statusFor: Record<FlightStageKey, FlightStageStatus> = {
    // The feature exists in the workspace at all → it was (implicitly or
    // explicitly) scouted. similarity is plumbing — stageRailRows hides it
    // unless parked/failed, which evidence can never be.
    'similarity': 'done',
    'scout': 'done',
    // Suite setup = the config was proven to work, which is what the conducted
    // env-capture stage settles on: a dry-run BOOT. A captured envset is one
    // way to get there and `captured: 0` is another — an app with no env files
    // has nothing to capture, and reading the envset as mandatory left every
    // such suite dark forever, green runs and all. Both halves carry the pair
    // outcome so the merged cell can't overclaim a scaffold-only feature.
    'scaffold': suiteSetUp ? 'done' : 'pending',
    'env-capture': suiteSetUp ? 'done' : 'pending',
    // Requirements = the distilled summary exists (covers description-only
    // summaries where docs/ holds no source docs).
    'docs': ev.prdSummary ? 'done' : 'pending',
    'prd-summary': ev.prdSummary ? 'done' : 'pending',
    // "Test authoring & coverage" is TWO things, and a spec file only proves the
    // first. Coverage is a mapping onto requirements, so with no PRD summary it
    // was never computed and never could be — marking the step done off an
    // authored spec alone put a green tick on a suite with zero coverage. The
    // percentage itself is reported, not gated: a conducted flight may settle
    // this stage below target via accept-partial, so "done" means mapped, not
    // fully covered.
    'specs-coverage': ev.specs && ev.prdSummary ? 'done' : 'pending',
    // Parallel readiness asks whether the feature can boot beside a second copy
    // of itself, and a saved overlay is one route there, not the definition. A
    // config whose every start command already declares a port slot is
    // concurrency-ready with nothing for Portify to rewrite — reporting that as
    // "not started" would tell the user to redo work the config already does.
    'portify': feature.portified || ev.portInjectability === 'declared' ? 'done' : 'pending',
    'run': runStatus,
    'heal': runStatus,
    'evaluation-export': hasExport ? 'done' : 'pending',
  }
  return FLIGHT_STAGE_KEYS.map((key) => ({ key, status: statusFor[key] }))
}

// ---------------------------------------------------------------------------
// R81 — derived flights: a feature whose stages were completed OUTSIDE the
// conductor has flown. The flight record is the conductor's journal, not the
// definition of a flight, so the picker routes such a feature to the flight
// detail view under a token id instead of dead-ending on a start-from-scratch
// dialog. The token qualifies `view=flights` exactly like a real flightId
// (URL-only, per cl_route-every-surface), and FlightPage swaps in a
// pseudo-manifest so the whole rail/panel render path is reused unchanged.

/** URL/id prefix marking a derived flight — `feature:<name>` (a real flightId
 *  is `fl_<hex>`, so the two id spaces can never collide). */
export const DERIVED_FLIGHT_PREFIX = 'feature:'

export function derivedFlightToken(feature: string): string {
  return `${DERIVED_FLIGHT_PREFIX}${feature}`
}

/** The feature a derived token points at, or null for a real flightId. */
export function derivedFlightFeature(flightId: string): string | null {
  return flightId.startsWith(DERIVED_FLIGHT_PREFIX)
    ? flightId.slice(DERIVED_FLIGHT_PREFIX.length) || null
    : null
}

/** A client-only FlightManifest standing in for evidence-derived progress.
 *  Never persisted and never sent to the server — it exists so FlightPage can
 *  render derived stages through the same rail, panels and drill-throughs a
 *  recorded flight uses. `status` is computed, not invented: every derived
 *  stage done → `done`; anything still open → `paused` (the page overrides the
 *  chip copy and controls in derived mode, so no "paused by you" lie reaches
 *  the user). */
export function buildDerivedManifest(
  feature: string,
  stages: DerivedStage[],
  prefill?: { repoPaths?: string[]; description?: string; env?: string; evidence?: Partial<Record<FlightStageKey, Record<string, unknown>>> },
): FlightManifest {
  const allDone = stages.every((s) => s.status === 'done')
  return {
    flightId: derivedFlightToken(feature),
    feature,
    repoPaths: prefill?.repoPaths ?? [],
    // The feature config's own description — the entry prefill falls through to
    // it when no flight ever recorded an intent. Without it the Repo scan panel
    // renders its "Intent · what to test" heading over an empty line.
    description: prefill?.description ?? '',
    opts: { env: prefill?.env ?? 'local', coverageTarget: 100, yolo: false },
    status: allDone ? 'done' : 'paused',
    currentStage: null,
    // Evidence probed from the workspace rides along so every panel renders facts
    // through its normal `stage.evidence` path.
    //
    // Attached regardless of the stage's status, because a probe returning a block
    // IS proof the artifact is on disk — and a step can be part-done: specs
    // authored with no requirements to map them against leaves this stage open
    // while its spec files genuinely exist. Gating on `done` would hide that real
    // work behind a bare "not started". A stage with no artifact to report still
    // carries nothing, so nothing is invented for a step that never happened.
    stages: stages.map((s) => {
      const evidence = prefill?.evidence?.[s.key]
      return evidence
        ? { key: s.key, status: s.status, evidence, evidenceSource: 'workspace' as const }
        : { key: s.key, status: s.status }
    }),
    createdAt: '',
    updatedAt: '',
  }
}

/** The stage a derived flight would be conducted FROM: the first one whose
 *  evidence is missing. Null when every stage is already done (nothing to
 *  continue — the offer is a fresh flight instead). Mirrors the server's
 *  stage-entry validator, which has the final say at submit time. */
export function derivedEntryStage(stages: DerivedStage[]): FlightStageKey | null {
  return stages.find((s) => s.status !== 'done')?.key ?? null
}

/** The latest settled test run per feature (boots/benchmarks/verifies are not
 *  feature runs; active runs surface via the activity overlay instead). */
export function latestTerminalRunByFeature(runs: RunIndexEntry[]): Map<string, RunIndexEntry> {
  const map = new Map<string, RunIndexEntry>()
  for (const r of runs) {
    if (r.executionType === 'boot' || r.executionType === 'benchmark' || r.executionType === 'verify') continue
    if (r.status !== 'passed' && r.status !== 'failed') continue
    const prev = map.get(r.feature)
    if (!prev || r.startedAt.localeCompare(prev.startedAt) > 0) map.set(r.feature, r)
  }
  return map
}

function hasDoneExport(tasks: EvaluationExportTask[], feature: string): boolean {
  return tasks.some((t) => t.feature === feature && t.status === 'completed')
}

/** Hook form — per-feature derived rails from the live runs + export stores
 *  (must be called under Runs/EvaluationExport providers). The map re-derives
 *  when a run settles or an export lands, so the squares stay live without a
 *  features refetch. */
export function useDerivedFeatureStages(features: Feature[]): Map<string, DerivedStage[]> {
  const { runs } = useRuns()
  const { tasks } = useEvaluationExports()
  return useMemo(() => {
    const latest = latestTerminalRunByFeature(runs)
    const map = new Map<string, DerivedStage[]>()
    for (const f of features) {
      const stages = deriveFeatureStages(f, latest.get(f.name), hasDoneExport(tasks, f.name))
      if (stages) map.set(f.name, stages)
    }
    return map
  }, [features, runs, tasks])
}
