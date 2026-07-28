import type {
  CoverageLedger,
  RunIndexEntry,
  RunLifecycleEvent,
  ServiceManifestEntry,
  TestStrength,
} from '@/shared/api/types'
import { durationBetween } from '@/shared/lib/format'
import { isTerminalRunStatus } from '@shared/run-state'

// ─── Stage band measurements ────────────────────────────────────────────────
// The "At a glance" band reports COUNTS, so each one is derived here, once, and
// pinned by stage-metrics.test.ts. Two rules run through everything below:
//
//   • Never round an unknown into a known. A run still going is not a failure,
//     an ungraded test is not a shallow one, and a feature with no recorded run
//     has no proven percentage — those cases return null, not zero.
//   • Never recompute a number the engine already computed. Coverage and proven
//     come off `ledger.totals`; this module only reshapes them.

export interface RunHistoryStats {
  /** Every real test run for the feature, finished or not. */
  total: number
  passed: number
  failed: number
  aborted: number
  /** Queued, running or healing — counted in `total`, in no outcome bucket. */
  active: number
  /** Mean wall-clock over the runs that finished; null when none have. */
  avgDurationMs: number | null
  longestDurationMs: number | null
  /** Repair cycles summed across the feature's runs. */
  healCycles: number
  runsWithRepairs: number
}

/** Aggregate a feature's run history. Null for a feature with no runs at all —
 *  a band of zeroes would claim we measured something. */
export function runHistoryStats(runs: RunIndexEntry[]): RunHistoryStats | null {
  if (runs.length === 0) return null
  const durations = runs
    .map((r) => durationBetween(r.startedAt, r.endedAt))
    .filter((ms): ms is number => ms != null)
  const outcome = (status: RunIndexEntry['status']): number =>
    runs.filter((r) => r.status === status).length
  return {
    total: runs.length,
    passed: outcome('passed'),
    failed: outcome('failed'),
    aborted: outcome('aborted'),
    active: runs.filter((r) => !isTerminalRunStatus(r.status)).length,
    avgDurationMs: durations.length > 0
      ? Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length)
      : null,
    longestDurationMs: durations.length > 0 ? Math.max(...durations) : null,
    healCycles: runs.reduce((sum, r) => sum + (r.healCycles ?? 0), 0),
    runsWithRepairs: runs.filter((r) => (r.healCycles ?? 0) > 0).length,
  }
}

/** How long the services took to come up: the span from the first
 *  `starting-services` event to `services-ready`. Deliberately NOT the boot
 *  run's own start→end, which also spans the queue wait behind a busy repo and
 *  the teardown the flight always performs — either can dwarf the boot itself. */
export function bootDurationMs(events: RunLifecycleEvent[] | undefined): number | null {
  if (!events) return null
  const at = (phase: RunLifecycleEvent['phase']): number | null => {
    const match = events.find((e) => e.phase === phase)
    const t = match ? Date.parse(match.updatedAt) : NaN
    return Number.isFinite(t) ? t : null
  }
  const start = at('starting-services')
  const ready = at('services-ready')
  if (start == null || ready == null || ready < start) return null
  return ready - start
}

/** One service's time-to-ready from its stamped pair. Null on runs recorded
 *  before the stamps existed, so the row shows a status without inventing a
 *  duration. */
export function serviceReadyMs(service: Pick<ServiceManifestEntry, 'startingAt' | 'readyAt'>): number | null {
  if (!service.startingAt || !service.readyAt) return null
  return durationBetween(service.startingAt, service.readyAt)
}

/** Rough token count for a document of `bytes`, at the usual four-characters-
 *  per-token approximation. An estimate by construction — callers render it
 *  with a `≈` so it never reads as a measured figure. */
export function estimateTokens(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0
  return Math.round(bytes / 4)
}

export interface OverlayDiffStat {
  files: number
  added: number
  removed: number
  byFile: Array<{ path: string; added: number; removed: number }>
}

/** File and line counts from the portify overlay's unified diff. The `+++`/`---`
 *  header lines are skipped — counting them would add two phantom changed lines
 *  per file. */
export function overlayDiffStat(diff: string | undefined): OverlayDiffStat | null {
  if (!diff) return null
  const byFile: OverlayDiffStat['byFile'] = []
  let current: OverlayDiffStat['byFile'][number] | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '').trim()
      current = { path, added: 0, removed: 0 }
      byFile.push(current)
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('@@')) continue
    if (!current) continue
    if (line.startsWith('+')) current.added += 1
    else if (line.startsWith('-')) current.removed += 1
  }
  if (byFile.length === 0) return null
  return {
    files: byFile.length,
    added: byFile.reduce((sum, f) => sum + f.added, 0),
    removed: byFile.reduce((sum, f) => sum + f.removed, 0),
    byFile,
  }
}

export interface StrengthCounts extends Record<TestStrength, number> {
  /** Tests the grader never scored. Its own bucket: folding these into
   *  `shallow` would report an unmeasured test as a weak one. */
  ungraded: number
}

export interface LedgerEvidence {
  /** Requirements whose coverage a passing test actually confirmed. Null when
   *  the feature has no recorded run, so there is no proven axis to report. */
  proven: number | null
  total: number
  provenPct: number | null
  /** What the coverage stage reports — claimed by annotation, run-blind. */
  claimedPct: number
  testCount: number
  strength: StrengthCounts
}

/** Reshape the coverage ledger into what the Evaluation Report band shows.
 *  Every figure is read off the ledger the engine computed — the percentages
 *  are never recalculated here, so the band, the ledger page and
 *  `get_feature_coverage` cannot disagree. */
export function ledgerEvidence(ledger: CoverageLedger | null | undefined): LedgerEvidence | null {
  if (!ledger || ledger.totals.total === 0) return null
  const strength: StrengthCounts = { strong: 0, solid: 0, basic: 0, shallow: 0, ungraded: 0 }
  for (const test of ledger.tests) {
    if (test.strength) strength[test.strength] += 1
    else strength.ungraded += 1
  }
  return {
    proven: ledger.totals.proven ?? null,
    total: ledger.totals.total,
    provenPct: ledger.provenPct ?? null,
    claimedPct: ledger.coveragePct,
    testCount: ledger.tests.length,
    strength,
  }
}
