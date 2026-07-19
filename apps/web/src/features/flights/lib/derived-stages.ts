import { useMemo } from 'react'
import { FLIGHT_STAGE_KEYS } from '../../../../../../shared/flights/types'
import type { FlightStageKey, FlightStageStatus } from '../../../shared/api/client'
import type { EvaluationExportTask, Feature, RunIndexEntry } from '../../../shared/api/types'
import { useRuns } from '../../runs/state/RunsContext'
import { useEvaluationExports } from '../../evaluation/state/EvaluationExportContext'

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
  const statusFor: Record<FlightStageKey, FlightStageStatus> = {
    // The feature exists in the workspace at all → it was (implicitly or
    // explicitly) scouted. similarity is plumbing — stageRailRows hides it
    // unless parked/failed, which evidence can never be.
    'similarity': 'done',
    'scout': 'done',
    // Suite setup = config + captured env (boot-proof) — both halves carry the
    // pair outcome so the merged cell can't overclaim a scaffold-only feature.
    'scaffold': ev.envCapture ? 'done' : 'pending',
    'env-capture': ev.envCapture ? 'done' : 'pending',
    // Requirements = the distilled summary exists (covers description-only
    // summaries where docs/ holds no source docs).
    'docs': ev.prdSummary ? 'done' : 'pending',
    'prd-summary': ev.prdSummary ? 'done' : 'pending',
    'specs-coverage': ev.specs ? 'done' : 'pending',
    'portify': feature.portified ? 'done' : 'pending',
    'run': runStatus,
    'heal': runStatus,
    'evaluation-export': hasExport ? 'done' : 'pending',
  }
  return FLIGHT_STAGE_KEYS.map((key) => ({ key, status: statusFor[key] }))
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
