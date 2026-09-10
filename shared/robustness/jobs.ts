import type { RobustnessAtomKind, RobustnessEnvelope } from './types'
import type { ShrinkResult } from './shrink'

// The Robustness Lab job record (D16): one background job per suite that runs
// the matrix — every spec file under every atom of the suite's envelope — and
// shrinks what fails. The record is the one home for its shape: the server
// store writes it, the stage pane and the MCP `get_robustness` result read it.
//
// A job carries FINDINGS, never counts. The green run's verdict is a different
// record and this one never touches it; what it adds is "under this envelope,
// these tests failed, and here is the smallest envelope that still makes them
// fail". A finding that could not be confirmed 3/3 stays in the list as
// `unconfirmed` with its trace — shown as such, never dropped, never promoted.

export type RobustnessJobStatus = 'running' | 'done' | 'failed' | 'aborted'

/** One matrix cell: a spec file run under one atom of the envelope. */
export interface RobustnessCell {
  /** Spec path relative to the suite folder the green run executed (its
   *  run-start snapshot), e.g. `e2e/storefront.spec.ts`. */
  specFile: string
  atom: RobustnessAtomKind
}

/** A cell the matrix could not judge: its run never produced a verdict (a
 *  service failed to boot, the run was aborted) or the green run recorded no
 *  location for a test. Named so the certificate can list what was NOT proven
 *  — a skipped cell is never a finding and never a pass. */
export interface RobustnessSkippedCell {
  cell: RobustnessCell
  reason: string
  runId?: string
}

export type RobustnessFindingStatus = 'found' | 'shrinking' | 'confirmed' | 'unconfirmed'

export interface RobustnessFinding {
  cell: RobustnessCell
  /** Test titles that failed in this cell and passed in the green run. */
  failedTests: string[]
  /** The cell run that produced the finding — the trace and logs live there. */
  runId: string
  /** `@req-*` tags read from the failed tests, so the pane renders per requirement. */
  requirements: string[]
  status: RobustnessFindingStatus
  /** The envelope this cell ran under — the one atom, at its declared knobs. */
  envelope: RobustnessEnvelope
  /** Present once shrink has run; `repro` is its one-line answer. */
  shrink?: ShrinkResult
  repro?: string
}

export interface RobustnessJobManifest {
  jobId: string
  feature: string
  /** The green run whose spec files and test titles the matrix is built from. */
  runId: string
  envelope: RobustnessEnvelope
  status: RobustnessJobStatus
  startedAt: string
  endedAt?: string
  cells: { planned: number; done: number }
  findings: RobustnessFinding[]
  skipped: RobustnessSkippedCell[]
  /** Driver output, appended as the matrix and shrink run. */
  log: string
  error?: string
}

export interface RobustnessJobIndexEntry {
  jobId: string
  feature: string
  runId: string
  status: RobustnessJobStatus
  startedAt: string
  endedAt?: string
  /** Findings so far — a live count for a list row, not a verdict. */
  findings: number
}
