import fs from 'fs'
import path from 'path'
import type { CoverageLedger, ProposedMapping, Requirement } from '../../../../../../../shared/coverage/types'
import type { AgentJobRecordRef } from '../../../agent-sessions/logic/agent-jobs/types'
import { hasNegativeAssertion } from './strength'
import {
  buildAnnotatePrompt,
  proposeCoverageMappings,
  type AnnotateAdapter,
  type AnnotateTestInput,
  type CoverageAgentSession,
} from './annotate-engine'
import { writeCoversTag } from './tag-writer'
import { changedRequirementIds, requirementFingerprintMap, requirementsSetHash } from './fingerprints'
import { readCoverageRunState, writeCoverageRunState } from './run-state'
import { readPrdSummary } from './prd-summary'
import { clearPrdSummary } from './feature-docs'
import { FeatureNotFoundError, collectTests, computeFeatureCoverage, resolveFeatureDir } from './service'

// Legacy review-queue sidecar (removed with the accept/reject flow). Still named
// here so `clearPrdSummary` and the flight's specs-coverage reset clean up any
// file left by an older build.
export const LEGACY_MAPPINGS_JSON = '_coverage-mappings.json'

// ---------------------------------------------------------------------------
// Coverage engine — annotate-pass (R2). Infers which requirement(s) each
// untagged test verifies and writes the `covers` tag straight away. Summary +
// Coverage are one exercise (R16): there is no review gate — mappings auto-apply.
// ---------------------------------------------------------------------------

export interface RunCoverageEngineArgs {
  featuresDir: string
  logsDir: string
  feature: string
  adapter?: AnnotateAdapter
  /** 'full' re-infers against every active requirement; 'delta' (R10) re-infers
   *  only requirements whose fingerprint changed since the last engine run — and
   *  no-ops entirely when nothing changed. Default 'full'. */
  mode?: 'full' | 'delta'
  cwd?: string
  now?: string
  signal?: AbortSignal
  /** Stop scope for the mapping agent this engine spawns, forwarded to the shared
   *  runner. Flights pass their `coverage-map` sidecar dir; the standalone
   *  coverage job passes none — its own job manifest is the record and its own
   *  cancellation path is separate. */
  spawnScope?: string
  /** Durable-record descriptor, forwarded to the shared runner. */
  agentJob?: { record: AgentJobRecordRef; logsDir: string }
  onOutput?: (chunk: string) => void
  onAgentSession?: (session: CoverageAgentSession) => void
}

export interface RunCoverageEngineResult {
  feature: string
  /** Mappings whose `covers` tags were written this pass. */
  applied: ProposedMapping[]
  /** Test names that were orphans before the pass. */
  orphanTestsBefore: string[]
  /** delta mode: the requirement ids re-inferred this pass (the changed set). */
  reconciledRequirementIds?: string[]
  /** The recomputed ledger after applying (auto) or storing (review). */
  ledger: CoverageLedger
}

/** Resolve a relative spec path under the feature and write a covers tag onto a
 *  test. Returns true when the file changed. */
export function applyTagToFile(
  featureDir: string,
  relFile: string,
  testName: string,
  requirements: string[],
  pathTypes: ProposedMapping['pathTypes'],
  variants?: ProposedMapping['variants'],
): boolean {
  const abs = path.join(featureDir, relFile)
  if (!fs.existsSync(abs)) return false
  const source = fs.readFileSync(abs, 'utf-8')
  const next = writeCoversTag(source, testName, { requirements, pathTypes, variants })
  if (next === source) return false
  fs.writeFileSync(abs, next)
  return true
}

/** The slice of a test's source the mapping validator inspects. */
export interface MappingTestSource {
  assertions: string[]
  bodySource: string
}

/**
 * Deterministic claim-validation for one proposed mapping — FLAG, never drop.
 * Returns zero or more human-readable issue strings for suspicious claims:
 * low confidence, a `@path-sad` claim with no negative assertion, a `@variant-*`
 * claim whose value never appears in the test source. The tag is still written
 * exactly as before (auto-apply has no review gate); the issues ride on the
 * applied mapping so the concern is visible. ONE home, called by BOTH apply
 * lanes (auto `runCoverageEngine` + external `applyExternalCoverageMappings`).
 */
export function flagMappingIssues(mapping: ProposedMapping, test?: MappingTestSource): string[] {
  const issues: string[] = []
  if (mapping.confidence !== undefined && mapping.confidence < 0.5) {
    issues.push(`low confidence (${mapping.confidence.toFixed(2)})`)
  }
  if (!test) return issues // no readable source → only the confidence check
  const snippets = [...test.assertions, test.bodySource]
  if (mapping.pathTypes?.includes('sad') && !hasNegativeAssertion(snippets)) {
    issues.push('@path-sad claimed but test has no negative assertion (toThrow/rejects/.not/error-status)')
  }
  const source = snippets.join('\n').toLowerCase()
  for (const v of mapping.variants ?? []) {
    if (!source.includes(v.toLowerCase())) {
      issues.push(`@variant-${v} claimed but '${v}' not found in test source`)
    }
  }
  return issues
}

/** Test seam: inject a fake mapper so unit tests don't spawn a real agent
 *  (production always uses the real, agent-backed `proposeCoverageMappings`). */
export interface RunCoverageEngineDeps {
  propose?: typeof proposeCoverageMappings
}

export async function runCoverageEngine(
  args: RunCoverageEngineArgs,
  deps: RunCoverageEngineDeps = {},
): Promise<RunCoverageEngineResult> {
  const propose = deps.propose ?? proposeCoverageMappings
  const featureDir = resolveFeatureDir(args.featuresDir, args.feature)
  const summary = readPrdSummary(featureDir)
  const requirements: Requirement[] = summary?.requirements ?? []

  const { collected } = collectTests(featureDir)
  const orphans = collected.filter((c) => !(c.input.requirements?.length))
  const orphanTestsBefore = orphans.map((c) => c.input.name).sort()

  // Re-map EVERY test each run — not just the untagged orphans. The agent
  // re-examines every requirement↔test pair so the mapping is genuinely
  // re-derived (and the "Mapping coverage" phase is real, visible agent work,
  // not an instant no-op when specs already carry tags). Tag-writes are
  // idempotent + additive (tag-writer.ts), so a re-confirmed mapping doesn't
  // churn the spec; only new/changed linkages produce a diff.
  const engineInputs = collected.map((c) => ({
    name: c.input.name,
    file: c.input.file,
    bodySource: c.bodySource,
    assertions: [...c.assertions],
  }))

  // Reconcile-by-delta (R10): in delta mode, restrict the candidate requirements
  // to those whose fingerprint changed since the last engine run — unchanged reqs
  // keep their existing mappings, and an unchanged set is a no-op.
  let candidateRequirements = requirements
  let reconciledRequirementIds: string[] | undefined
  if (args.mode === 'delta') {
    const prior = readCoverageRunState(featureDir)
    const changedIds = changedRequirementIds(requirements, prior?.requirementFingerprints)
    reconciledRequirementIds = changedIds
    if (changedIds.length === 0) {
      args.onOutput?.('[delta] requirements unchanged — nothing to reconcile\n')
      return { feature: args.feature, applied: [], orphanTestsBefore, reconciledRequirementIds, ledger: computeFeatureCoverage(args) }
    }
    args.onOutput?.(`[delta] reconciling ${changedIds.length} changed requirement(s): ${changedIds.join(', ')}\n`)
    const changedSet = new Set(changedIds)
    candidateRequirements = requirements.filter((r) => changedSet.has(r.id))
  }

  const proposals = await propose(
    { requirements: candidateRequirements, variantDimension: summary?.variantDimension, tests: engineInputs, adapter: args.adapter, featureDir, cwd: args.cwd, signal: args.signal, spawnScope: args.spawnScope, agentJob: args.agentJob, onOutput: args.onOutput, onSession: args.onAgentSession },
  )

  // No review gate (R16): every inferred mapping's `covers` tag is written now.
  // Agent proposals report only a testName (the agent reads the spec but doesn't
  // echo its path), so backfill `file` by name from the engine's orphan inputs —
  // without this the entire agentic mapping path is a no-op at tag-writing.
  const fileByTestName = new Map(engineInputs.map((t) => [t.name, t.file]))
  const sourceByTestName = new Map<string, MappingTestSource>(
    engineInputs.map((t) => [t.name, { assertions: t.assertions, bodySource: t.bodySource ?? '' }]),
  )
  const applied: ProposedMapping[] = []
  for (const m of proposals) {
    const file = m.file ?? fileByTestName.get(m.testName)
    if (!file) continue
    if (applyTagToFile(featureDir, file, m.testName, m.requirements, m.pathTypes, m.variants)) {
      // FLAG, don't drop: suspicious claims still apply, but carry `issues`.
      const issues = flagMappingIssues(m, sourceByTestName.get(m.testName))
      applied.push({ ...m, file, ...(issues.length ? { issues } : {}) })
    }
  }

  // Record the requirements set the engine just ran against — coverage drops to
  // STALE when the set later moves (R3 signal; R10 turns it into a delta re-infer).
  writeCoverageRunState(featureDir, {
    requirementsHash: summary?.requirementsHash ?? requirementsSetHash(requirements),
    requirementFingerprints: requirementFingerprintMap(requirements),
    ranAt: args.now ?? new Date().toISOString(),
  })

  const ledger = computeFeatureCoverage({ featuresDir: args.featuresDir, logsDir: args.logsDir, feature: args.feature })
  return { feature: args.feature, applied, orphanTestsBefore, reconciledRequirementIds, ledger }
}

// ---------------------------------------------------------------------------
// External (offloaded) coverage — the SAME annotate exercise, but the calling
// MCP client does the inference instead of a Canary-spawned agent. Canary hands
// the client the mapping context (below), the client returns `mappings`, and
// `applyExternalCoverageMappings` writes the tags through the canonical
// tag-writer + recomputes — so the offload path never re-implements either the
// prompt or the tag-write. The ledger recompute is producer-agnostic.
// ---------------------------------------------------------------------------

export interface CoverageMappingTest {
  testName: string
  /** Absolute spec path the client should read before mapping. */
  file?: string
  assertions: string[]
}

export interface CoverageMappingContext {
  feature: string
  /** Active requirements the client may map to (deprecated ones excluded). */
  requirements: Requirement[]
  /** The feature's tests, with resolvable file paths to read. */
  tests: CoverageMappingTest[]
  /** The full mapping prompt (instructions + requirements + test paths + the
   *  expected `{ mappings: [...] }` output shape) — hand this to the client
   *  verbatim. Reuses the internal annotate prompt so both surfaces agree. */
  prompt: string
}

/** True when a feature has a PRD summary — required before coverage mapping (the
 *  requirements are the spine the mappings link to). */
export function hasPrdSummary(featuresDir: string, feature: string): boolean {
  return Boolean(readPrdSummary(resolveFeatureDir(featuresDir, feature)))
}

/** Assemble the read-only context an offloaded client needs to map tests →
 *  requirements. Throws FeatureNotFoundError for an unknown feature; the caller
 *  is responsible for checking hasPrdSummary first. */
export function buildCoverageMappingContext(args: { featuresDir: string; feature: string }): CoverageMappingContext {
  const featureDir = resolveFeatureDir(args.featuresDir, args.feature)
  const summary = readPrdSummary(featureDir)
  const requirements = (summary?.requirements ?? []).filter((r) => !r.deprecated)
  const { collected } = collectTests(featureDir)
  const engineInputs: AnnotateTestInput[] = collected.map((c) => ({
    name: c.input.name,
    file: c.input.file,
    assertions: [...c.assertions],
  }))
  const prompt = buildAnnotatePrompt(summary?.requirements ?? [], engineInputs, featureDir, summary?.variantDimension)
  return {
    feature: args.feature,
    requirements,
    tests: engineInputs.map((t) => ({
      testName: t.name,
      file: t.file && featureDir ? path.join(featureDir, t.file) : t.file,
      assertions: t.assertions!,
    })),
    prompt,
  }
}

export interface ApplyExternalCoverageArgs {
  featuresDir: string
  logsDir: string
  feature: string
  mappings: ProposedMapping[]
  now?: string
}

export interface ApplyExternalCoverageResult {
  feature: string
  applied: ProposedMapping[]
  ledger: CoverageLedger
}

/** Apply a client-supplied set of mappings: write each `covers` tag through the
 *  canonical tag-writer (idempotent/additive) and recompute the ledger. Mirrors
 *  the apply-tail of `runCoverageEngine` but spawns NO agent — the inference
 *  already happened on the client. Mappings pointing at unknown requirement ids
 *  or unknown test names are dropped (no inventing the spine). */
export function applyExternalCoverageMappings(args: ApplyExternalCoverageArgs): ApplyExternalCoverageResult {
  const featureDir = resolveFeatureDir(args.featuresDir, args.feature)
  const summary = readPrdSummary(featureDir)
  const requirements: Requirement[] = summary?.requirements ?? []
  const knownIds = new Set(requirements.filter((r) => !r.deprecated).map((r) => r.id))

  const { collected } = collectTests(featureDir)
  const fileByTestName = new Map(collected.map((c) => [c.input.name, c.input.file]))
  const sourceByTestName = new Map<string, MappingTestSource>(
    collected.map((c) => [c.input.name, { assertions: [...c.assertions], bodySource: c.bodySource }]),
  )
  // Controlled vocabulary: drop variant claims outside the feature's dimension.
  const knownVariants = new Set(summary?.variantDimension?.values ?? [])

  const applied: ProposedMapping[] = []
  for (const m of args.mappings) {
    const requirementsFiltered = (m.requirements ?? []).filter((id) => knownIds.has(id))
    if (!requirementsFiltered.length) continue
    const file = m.file ?? fileByTestName.get(m.testName)
    if (!file) continue // unknown test name → not a mapping
    const variantsFiltered = (m.variants ?? [])
      .map((v) => v.trim().toLowerCase())
      .filter((v) => knownVariants.has(v))
    if (applyTagToFile(featureDir, file, m.testName, requirementsFiltered, m.pathTypes, variantsFiltered)) {
      const appliedMapping: ProposedMapping = { ...m, requirements: requirementsFiltered, variants: variantsFiltered.length ? variantsFiltered : undefined, file }
      // FLAG, don't drop: same shared validator as the auto lane, run against
      // the mapping as actually applied (post vocabulary filtering).
      const issues = flagMappingIssues(appliedMapping, sourceByTestName.get(m.testName))
      applied.push(issues.length ? { ...appliedMapping, issues } : appliedMapping)
    }
  }

  // Mirror runCoverageEngine: record the requirements set this pass ran against,
  // so coverage drops to STALE when the set later moves.
  writeCoverageRunState(featureDir, {
    requirementsHash: summary?.requirementsHash ?? requirementsSetHash(requirements),
    requirementFingerprints: requirementFingerprintMap(requirements),
    ranAt: args.now ?? new Date().toISOString(),
  })

  const ledger = computeFeatureCoverage({ featuresDir: args.featuresDir, logsDir: args.logsDir, feature: args.feature })
  return { feature: args.feature, applied, ledger }
}
