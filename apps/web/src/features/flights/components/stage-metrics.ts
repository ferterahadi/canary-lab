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
  byFile: Array<{
    path: string
    /** Which repo (or the feature config) this file belongs to, from the block
     *  header. Absent on a diff captured before the headers existed. */
    group?: string
    added: number
    removed: number
  }>
}

/** The `group` label for the feature-config block. One constant so the parser and
 *  the panel that counts repos agree on the literal. */
export const CONFIG_GROUP = 'feature config'

/** Block header the portify capture writes ahead of each repo group's diff
 *  (`# repo: a, b`) and ahead of the feature-config diff. */
const OVERLAY_GROUP = /^# (repo|feature config): (.+)$/

/** File and line counts from the portify overlay's unified diff. The `+++`/`---`
 *  header lines are skipped — counting them would add two phantom changed lines
 *  per file.
 *
 *  Paths are repo-RELATIVE (each block is a `git diff` inside that group's
 *  worktree), so two repos with a `build.gradle` yield two identical paths. The
 *  block header is what tells them apart, which is why it is parsed rather than
 *  skipped: without it the panel renders rows a reader cannot attribute. */
export function overlayDiffStat(diff: string | undefined): OverlayDiffStat | null {
  if (!diff) return null
  const byFile: OverlayDiffStat['byFile'] = []
  let current: OverlayDiffStat['byFile'][number] | null = null
  let group: string | undefined
  for (const line of diff.split('\n')) {
    const header = OVERLAY_GROUP.exec(line)
    if (header) {
      // The repo block names its member repos; the config block's value is the
      // feature directory — a path nobody needs, so the kind is the label.
      group = header[1] === 'repo' ? header[2].trim() : CONFIG_GROUP
      continue
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '').trim()
      current = { path, ...(group ? { group } : {}), added: 0, removed: 0 }
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

export interface OverlayFileGroup {
  /** The block label. Undefined for a diff captured before the headers existed,
   *  where the files render as one unlabelled group rather than claiming a repo. */
  group?: string
  files: OverlayDiffStat['byFile']
}

/** Overlay rows grouped by owning repo — groups in diff order, files worst-first
 *  WITHIN each group. The panel used to rank every file globally by size, which
 *  interleaved the repos; combined with repo-relative paths that made two
 *  different `build.gradle` files read as one duplicated row. Grouping is what
 *  makes a row attributable, and the size ranking survives inside the group. */
export function groupOverlayFiles(byFile: OverlayDiffStat['byFile']): OverlayFileGroup[] {
  const groups: OverlayFileGroup[] = []
  for (const file of byFile) {
    const existing = groups.find((g) => g.group === file.group)
    if (existing) existing.files.push(file)
    else groups.push({ group: file.group, files: [file] })
  }
  for (const group of groups) {
    group.files.sort((a, b) => (b.added + b.removed) - (a.added + a.removed))
  }
  return groups
}

/** Split a path so the panel can dim the directory and keep the filename. The
 *  trailing slash rides the directory, so the two halves concatenate back to the
 *  original with no separator of the renderer's own. */
export function splitFilePath(p: string): { dir: string; base: string } {
  const cut = p.lastIndexOf('/')
  return cut < 0 ? { dir: '', base: p } : { dir: p.slice(0, cut + 1), base: p.slice(cut + 1) }
}

export interface StrengthCounts extends Record<TestStrength, number> {
  /** Tests the grader never scored. Its own bucket: folding these into
   *  `shallow` would report an unmeasured test as a weak one. */
  ungraded: number
}

/** The specs that can carry proof at all — the ones annotated to a requirement —
 *  split by what the joined run did with them. An unmapped spec is excluded
 *  entirely: it may well pass, but it proves nothing about any requirement, so
 *  counting it would inflate the denominator with tests that cannot move the
 *  proven axis.
 *
 *  This is NOT the run's pass/fail count (that is the Test Run stage's, and
 *  reprinting it here is the duplication R80 removed). It is the same population
 *  the coverage stage reports as "Specs authored", re-read through the run — so
 *  the two stages describe one set of specs, once claimed and once proven. */
export interface ProofSpecs {
  mapped: number
  passed: number
  failed: number
  /** Mapped specs the joined run recorded no outcome for — new, renamed, or
   *  never reached. Its own bucket: a spec that never ran did not fail. */
  neverRan: number
}

export interface LedgerEvidence {
  /** Requirements whose coverage a passing test actually confirmed. Null when
   *  the feature has no recorded run, so there is no proven axis to report. */
  proven: number | null
  total: number
  /** The run `proven` (and every `lastRun` behind `specs`) was joined against.
   *  Carried through so a caller can check it is the run it is talking about —
   *  the engine joins the feature's LATEST run, which stops being this report's
   *  run the moment the suite runs again. Null when no run was joined. */
  provenRunId: string | null
  /** Requirements every declared path of which some annotated spec claims — what
   *  the coverage stage reports, by annotation and run-blind. The COUNT, not the
   *  percentage: the band renders it as `6/6` against the same denominator
   *  `proven` uses, so its two gates read as one fraction each and can be
   *  compared without a unit change in between. */
  covered: number
  testCount: number
  strength: StrengthCounts
  specs: ProofSpecs
}

/** Reshape the coverage ledger into what the Evaluation Report band shows.
 *  Every figure is read off the ledger the engine computed — nothing here is
 *  recalculated, so the band, the ledger page and `get_feature_coverage` cannot
 *  disagree. The band reports COUNTS on one denominator rather than the ledger's
 *  `coveragePct`/`provenPct` pair, which is why neither percentage is carried:
 *  two gates over the same requirements compare at a glance as `6/6` and `0/6`,
 *  where `100%` beside `0/6` made the reader convert one to see the other. */
export function ledgerEvidence(ledger: CoverageLedger | null | undefined): LedgerEvidence | null {
  if (!ledger || ledger.totals.total === 0) return null
  const strength: StrengthCounts = { strong: 0, solid: 0, basic: 0, shallow: 0, ungraded: 0 }
  const specs: ProofSpecs = { mapped: 0, passed: 0, failed: 0, neverRan: 0 }
  for (const test of ledger.tests) {
    if (test.strength) strength[test.strength] += 1
    else strength.ungraded += 1
    if (test.requirements.length === 0) continue
    specs.mapped += 1
    if (!test.lastRun) specs.neverRan += 1
    else if (test.lastRun.passed) specs.passed += 1
    else specs.failed += 1
  }
  return {
    proven: ledger.totals.proven ?? null,
    total: ledger.totals.total,
    provenRunId: ledger.provenRunId ?? null,
    covered: ledger.totals.covered,
    testCount: ledger.tests.length,
    strength,
    specs,
  }
}
