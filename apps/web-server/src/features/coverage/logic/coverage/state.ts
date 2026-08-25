import type {
  CoverageState,
  CoverageStateView,
  DriftDetail,
  SummaryState,
} from '../../../../../../../shared/coverage/types'

// Pure derivation of the (summary × coverage) state model (R3). No I/O — the
// service assembles the inputs (from disk + fingerprints) and calls this. Every
// reachable combination yields a non-dead-end headline; staleness always names
// the changed docs + affected artifacts.

export interface DeriveStateInput {
  hasSummary: boolean
  /** Source docs differ from the summary's stored fingerprints. */
  summaryDrifted: boolean
  /** Which source docs changed (added/edited/removed). */
  changedDocs: string[]
  /** Any test carries requirement linkage. */
  hasAnnotatedTests: boolean
  /** The coverage mapper has completed at least once, even if it found no
   *  valid links to write. This separates a measured 0% from work that has
   *  never run. */
  hasCoverageRun: boolean
  /** Requirements set changed since the engine last ran against it. */
  coverageStale: boolean
  coveragePct: number
  /** R4 hook: a background job currently running for this feature, if any. */
  activeJob?: 'summary' | 'coverage' | null
}

const PRD_ARTIFACT = 'PRD summary'
const COVERAGE_ARTIFACT = 'coverage ledger'

export type PersistedCoverageState = Extract<CoverageState, 'absent' | 'fresh' | 'stale'>

/** Coverage state that can be proven from durable workspace artifacts. Tags
 *  preserve legacy/manual mappings; the run marker also records a completed
 *  mapper that legitimately produced zero links. */
export function derivePersistedCoverageState(input: Pick<
  DeriveStateInput,
  'hasAnnotatedTests' | 'hasCoverageRun' | 'coverageStale'
>): PersistedCoverageState {
  if (!input.hasAnnotatedTests && !input.hasCoverageRun) return 'absent'
  if (input.coverageStale) return 'stale'
  return 'fresh'
}

export function deriveSummaryState(input: DeriveStateInput): SummaryState {
  if (input.activeJob === 'summary') return 'generating'
  if (!input.hasSummary) return 'absent'
  if (input.summaryDrifted) return 'stale'
  return 'fresh'
}

export function deriveCoverageState(input: DeriveStateInput, summaryState: SummaryState): CoverageState {
  if (input.activeJob === 'coverage') return 'generating'
  // Coverage is meaningless until the summary is fresh — block it otherwise.
  if (summaryState !== 'fresh') return 'blocked'
  return derivePersistedCoverageState(input)
}

function deriveHeadline(
  summaryState: SummaryState,
  coverageState: CoverageState,
  pct: number,
): string {
  if (summaryState === 'generating' || coverageState === 'generating') return 'Generating'
  if (summaryState === 'absent') return 'Setup needed'
  if (summaryState === 'stale') return 'Stale'
  // summary is fresh past here.
  if (coverageState === 'absent') return 'No coverage'
  if (coverageState === 'stale') return 'Stale'
  return `Covered ${pct}%`
}

function deriveDrift(input: DeriveStateInput): DriftDetail {
  const affected: string[] = []
  if (input.summaryDrifted) {
    affected.push(PRD_ARTIFACT, COVERAGE_ARTIFACT)
  } else if (input.coverageStale) {
    affected.push(COVERAGE_ARTIFACT)
  }
  return {
    drifted: input.summaryDrifted,
    changedDocs: input.changedDocs,
    affectedArtifacts: affected,
  }
}

export function deriveCoverageStateView(input: DeriveStateInput): CoverageStateView {
  const summary = deriveSummaryState(input)
  const coverage = deriveCoverageState(input, summary)
  return {
    summary,
    coverage,
    headline: deriveHeadline(summary, coverage, input.coveragePct),
    drift: deriveDrift(input),
  }
}
