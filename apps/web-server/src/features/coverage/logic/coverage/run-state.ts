import fs from 'fs'
import path from 'path'
import { docsDirFor } from './docs-collection'
import type { MappingInferenceCache } from './mapping-cache'

// Records the requirements-set hash the coverage engine last ran against. The
// state model compares this to the live summary's `requirementsHash`: if they
// differ, the requirements set moved since the engine last inferred tags, so
// coverage is STALE (v1 = signal only; R10 turns it into a delta re-infer).

export const COVERAGE_STATE_JSON = '_coverage-state.json'

export interface CoverageRunState {
  /** The requirements-set hash present when the engine last ran. */
  requirementsHash: string
  /** Per-requirement fingerprints at last run (id → fingerprint) — the baseline
   *  reconcile-by-delta (R10) diffs against to re-infer only changed reqs. */
  requirementFingerprints?: Record<string, string>
  /** Examined test/requirement inputs; this records inference, never run proof. */
  mappingInference?: MappingInferenceCache
  /** Last exact ledger percentage computed by a coverage pass. The suite-list
   *  status endpoint reads this small manifest instead of reparsing every spec.
   *  Absent on older manifests; those truthfully report "Covered" without a
   *  number until the next real coverage computation refreshes the record. */
  coveragePct?: number
  ranAt: string
  /** Conservative proof boundary: changed mapping inputs need a later run.
   * Re-mapping cannot launder an older pass into proof of new helper/config bytes. */
  verificationRequiredAfter?: string
}

export function verificationBoundary(prior: CoverageRunState | null, tests: Record<string, string>, now: string): string | undefined {
  const previous = prior?.mappingInference?.tests
  const changed = !previous || Object.keys(previous).length !== Object.keys(tests).length
    || Object.entries(tests).some(([name, fingerprint]) => previous[name]?.fingerprint !== fingerprint)
  return changed ? now : prior?.verificationRequiredAfter
}

function statePath(featureDir: string): string {
  return path.join(docsDirFor(featureDir), COVERAGE_STATE_JSON)
}

export function readCoverageRunState(featureDir: string): CoverageRunState | null {
  const file = statePath(featureDir)
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CoverageRunState
    return typeof parsed.requirementsHash === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function writeCoverageRunState(featureDir: string, state: CoverageRunState): void {
  const docsDir = docsDirFor(featureDir)
  fs.mkdirSync(docsDir, { recursive: true })
  fs.writeFileSync(statePath(featureDir), JSON.stringify(state, null, 2) + '\n')
}
