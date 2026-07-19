import fs from 'fs'
import path from 'path'
import { docsDirFor } from '../../coverage/logic/coverage/docs-collection'

// On-disk stage evidence — the artifacts each pipeline stage leaves behind.
// One home for the probes so the two consumers can't drift:
//   - the stage-entry validator (routes/flights.ts) gating a `fromStage` jump,
//   - the /api/features `evidence` payload driving the picker's derived rail
//     (a feature with no flight record still shows which steps are done).

/** Spec-file shapes the specs-coverage stage produces (mirrors the validator's
 *  historical regex — broader than feature-loader's `.spec.ts`-only listing). */
const SPEC_FILE_RE = /\.spec\.[cm]?[jt]sx?$/

/** A captured envset exists: `envsets/<env>/` is non-empty. With no `env`
 *  given, ANY non-empty envset directory counts (the derived rail asks "was
 *  the environment ever captured", not "for this specific env"). */
export function hasCapturedEnvset(featureDir: string, env?: string): boolean {
  const envsetsDir = path.join(featureDir, 'envsets')
  const nonEmpty = (dir: string): boolean => {
    try {
      return fs.readdirSync(dir).length > 0
    } catch {
      return false
    }
  }
  if (env !== undefined) return nonEmpty(path.join(envsetsDir, env))
  try {
    return fs
      .readdirSync(envsetsDir, { withFileTypes: true })
      .some((d) => d.isDirectory() && nonEmpty(path.join(envsetsDir, d.name)))
  } catch {
    return false
  }
}

/** The prd-summary stage's artifact — the distilled requirements summary. */
export function hasPrdSummary(featureDir: string): boolean {
  return fs.existsSync(path.join(docsDirFor(featureDir), '_prd-summary.json'))
}

/** The specs-coverage stage's artifact — at least one authored spec under e2e/. */
export function hasAuthoredSpecs(featureDir: string): boolean {
  const e2eDir = path.join(featureDir, 'e2e')
  try {
    return fs.readdirSync(e2eDir).some((f) => SPEC_FILE_RE.test(f))
  } catch {
    return false
  }
}

/** Per-feature evidence block shipped on each /api/features row. Scaffold is
 *  implied (the row only exists because feature.config loaded); portify ships
 *  as the existing top-level `portified` flag; run/heal/export state is the
 *  client's — its live runs + export stores already carry it. */
export interface FeatureStageEvidence {
  /** A captured envset exists (env-capture stage artifact + dry-run boot). */
  envCapture: boolean
  /** docs/_prd-summary.json exists (prd-summary stage artifact). */
  prdSummary: boolean
  /** At least one spec under e2e/ (specs-coverage stage artifact). */
  specs: boolean
}

export function deriveFeatureEvidence(featureDir: string): FeatureStageEvidence {
  return {
    envCapture: hasCapturedEnvset(featureDir),
    prdSummary: hasPrdSummary(featureDir),
    specs: hasAuthoredSpecs(featureDir),
  }
}
