import fs from 'fs'
import path from 'path'
import { docsDirFor } from '../../coverage/logic/coverage/docs-collection'
import { portInjectability, type PortInjectability } from '../../../../../../shared/launcher/port-injectability'
import type { RepoPrerequisite } from '../../../../../../shared/launcher/types'
import { listRuns } from '../../runs/logic/run-store'
import { readManifest } from '../../runs/logic/runtime/manifest'
import { buildRunPaths, runDirFor } from '../../runs/logic/runtime/run-paths'

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

/** How far back to look for a boot. A feature that has never booted pays one
 *  manifest read per run, so the scan is bounded; a feature that has booted
 *  almost always answers on the first (newest) entry. */
const BOOT_PROOF_SCAN_LIMIT = 25

export interface SuiteBootProof {
  /** The run whose services came up. */
  runId: string
  /** The services that reached ready, shaped like the conducted stage's own
   *  boot evidence so the Suite setup panel renders both identically. `status`
   *  is reported as `ready` rather than read off the manifest: the manifest's
   *  live status is rewritten to `stopped` at teardown, while `readyAt` — the
   *  thing this proof is built on — records that it did reach ready. Empty for
   *  a feature that boots nothing (its services live behind remote URLs). */
  services: Array<{ name: string; status: 'ready' }>
}

/** Suite setup's real predicate: this feature's services have been proven to
 *  boot at least once.
 *
 *  The env-capture stage settles on a dry-run boot and records `captured: 0`
 *  quite happily — an app with no env files has nothing to capture. So a
 *  captured envset is SUFFICIENT evidence of Suite setup, never necessary, and
 *  reading it as necessary left every env-less suite (the shipped
 *  `storefront_journey` among them) permanently dark no matter how many green
 *  runs it produced.
 *
 *  `readyAt` is the durable signal, not `status`: teardown rewrites every
 *  service's status to `stopped`, but the first-arrival stamp survives. A run
 *  whose services never came up ends `failed` with `bootFailure` set and its
 *  services unstamped, so a boot failure can't masquerade as proof. */
export function findBootProof(logsDir: string, feature: string): SuiteBootProof | null {
  let runIds: string[]
  try {
    runIds = listRuns(logsDir, { feature }).slice(0, BOOT_PROOF_SCAN_LIMIT).map((r) => r.runId)
  } catch {
    return null
  }
  for (const runId of runIds) {
    const manifest = readManifest(buildRunPaths(runDirFor(logsDir, runId)).manifestPath)
    if (!manifest) continue
    const services = manifest.services ?? []
    if (services.length === 0) {
      // Nothing to boot. Only a run that reached a verdict proves the suite is
      // set up; a queued or aborted one proves nothing.
      if (manifest.status === 'passed' || manifest.status === 'failed') return { runId, services: [] }
      continue
    }
    if (services.every((s) => Boolean(s.readyAt))) {
      return { runId, services: services.map((s) => ({ name: s.name, status: 'ready' })) }
    }
  }
  return null
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
  /** A captured envset exists (env-capture stage artifact). */
  envCapture: boolean
  /** This feature's services have been proven to boot — the other half of Suite
   *  setup, and the only half an app with no env files can ever satisfy. */
  booted: boolean
  /** docs/_prd-summary.json exists (prd-summary stage artifact). */
  prdSummary: boolean
  /** At least one spec under e2e/ (specs-coverage stage artifact). */
  specs: boolean
  /** How far the config gets this feature toward booting concurrently.
   *  Parallel readiness is a property of the config, not of Portify: a service
   *  that natively reads `PORT` declares its slot outright and needs no
   *  overlay. See shared/launcher/port-injectability.ts. */
  portInjectability: PortInjectability
}

/** `logsDir`/`feature` are optional so callers with no run history to consult
 *  (tests, config-only reads) keep working — they simply report
 *  `booted: false`. `repos` likewise defaults to a feature that starts nothing. */
export function deriveFeatureEvidence(
  featureDir: string,
  logsDir?: string,
  feature?: string,
  repos?: readonly RepoPrerequisite[],
): FeatureStageEvidence {
  return {
    envCapture: hasCapturedEnvset(featureDir),
    booted: logsDir !== undefined && feature !== undefined && findBootProof(logsDir, feature) !== null,
    prdSummary: hasPrdSummary(featureDir),
    specs: hasAuthoredSpecs(featureDir),
    portInjectability: portInjectability(repos),
  }
}
