import fs from 'fs'
import path from 'path'
import { loadFeatures, listSpecFiles } from '../../../config/logic/feature-loader'
import { extractTestsFromSource } from '../../../config/logic/ast-extractor'
import type {
  CoverageLedger,
  PrdSummary,
  ProposedMapping,
  Requirement,
} from '../../../../../../../shared/coverage/types'
import { computeCoverageLedger, type CoverageTestInput } from '../../../coverage/logic/coverage/ledger'
import { applyTestStrength, type TestAssertions } from '../../../coverage/logic/coverage/strength'
import {
  buildAnnotatePrompt,
  proposeCoverageMappings,
  type AnnotateAdapter,
  type AnnotateTestInput,
  type CoverageAgentSession,
} from '../../../coverage/logic/coverage/annotate-engine'
import { writeCoversTag, stripCoverageTags } from './tag-writer'
import { changedDocPaths, changedRequirementIds, diffDocs, fingerprintDocs, requirementFingerprintMap, requirementsSetHash } from '../../../coverage/logic/coverage/fingerprints'
import { deriveCoverageStateView, type DeriveStateInput } from './state'
import { COVERAGE_STATE_JSON, readCoverageRunState, writeCoverageRunState } from '../../../coverage/logic/coverage/run-state'
import { CoverageJobRunStore } from '../../../coverage/logic/coverage/jobs/store'
import {
  GENERATED_DOC_PREFIX,
  docsDirFor,
  isGeneratedDoc,
  readDocsCollection,
} from '../../../coverage/logic/coverage/docs-collection'
import {
  PRD_SUMMARY_JSON,
  PRD_SUMMARY_MD,
  readPrdSummary,
  summarizePrd,
  writePrdSummary,
  type SummarizeAdapter,
} from '../../../coverage/logic/coverage/prd-summary'

// The single computation layer for the Verified Coverage Ledger. Both the REST
// route (routes/coverage.ts) and the MCP tools (mcp/tools.ts) call these — so
// the UI and an agent always see the same numbers (dual-surface parity).

export class FeatureNotFoundError extends Error {
  constructor(public readonly feature: string) {
    super(`feature not found: ${feature}`)
    this.name = 'FeatureNotFoundError'
  }
}

function resolveFeatureDir(featuresDir: string, feature: string): string {
  const found = loadFeatures(featuresDir).find((f) => f.name === feature)
  if (!found || !found.featureDir) throw new FeatureNotFoundError(feature)
  return found.featureDir
}

/** True when a feature with this name is discoverable (cheap existence guard for
 *  the async job start path, which would otherwise fail deep in the driver). */
export function featureExists(featuresDir: string, feature: string): boolean {
  const found = loadFeatures(featuresDir).find((f) => f.name === feature)
  return Boolean(found && found.featureDir)
}

interface CollectedTest {
  input: CoverageTestInput
  assertions: Set<string>
  bodySource: string
  /** Absolute path of the spec that defines the test (for tag-writing). */
  absFile: string
}

interface CollectedTests {
  tests: CoverageTestInput[]
  assertions: TestAssertions[]
  collected: CollectedTest[]
}

/** Union two optional lists, deduplicating preserving first-seen order.
 *  Returns `a` unchanged (including undefined) when `b` is empty/absent. */
function unionList<T>(a: T[] | undefined, b: T[] | undefined): T[] | undefined {
  if (!b?.length) return a
  const s = new Set(a)
  for (const v of b) s.add(v)
  return [...s]
}

/** Merge per-test annotation/assertion data across all of a feature's specs. */
function collectTests(featureDir: string): CollectedTests {
  const byName = new Map<string, CollectedTest>()
  for (const file of listSpecFiles(featureDir)) {
    let source = ''
    try { source = fs.readFileSync(file, 'utf-8') } catch { continue }
    const extracted = extractTestsFromSource(file, source)
    for (const t of extracted.tests) {
      const absFile = t.sourceFile ?? file
      const existing = byName.get(t.name)
      if (existing) {
        // Same test name in two specs — union the linkage, concat assertions.
        existing.input.requirements = unionList(existing.input.requirements, t.requirements)
        existing.input.pathTypes = unionList(existing.input.pathTypes, t.pathTypes)
        for (const a of t.assertions ?? []) existing.assertions.add(a)
        continue
      }
      byName.set(t.name, {
        input: {
          name: t.name,
          requirements: t.requirements,
          pathTypes: t.pathTypes,
          file: path.relative(featureDir, absFile),
          line: t.line,
        },
        assertions: new Set(t.assertions ?? []),
        bodySource: t.bodySource,
        absFile,
      })
    }
  }
  const tests: CoverageTestInput[] = []
  const assertions: TestAssertions[] = []
  const collected: CollectedTest[] = []
  for (const entry of byName.values()) {
    tests.push(entry.input)
    assertions.push({ name: entry.input.name, assertions: [...entry.assertions] })
    collected.push(entry)
  }
  return { tests, assertions, collected }
}

function isDrifted(featureDir: string, summary: PrdSummary | null): boolean {
  const live = readDocsCollection(featureDir).docsHash
  if (!summary) {
    // No summary yet but source docs exist → needs an initial generation.
    return readDocsCollection(featureDir).entries.length > 0
  }
  return live !== summary.docsHash
}

export interface ComputeFeatureCoverageArgs {
  featuresDir: string
  logsDir: string
  feature: string
}

/** Assemble the full ledger (breadth + rigor + drift) for one feature. */
export function computeFeatureCoverage(args: ComputeFeatureCoverageArgs): CoverageLedger {
  const featureDir = resolveFeatureDir(args.featuresDir, args.feature)
  const summary = readPrdSummary(featureDir)
  const requirements = summary?.requirements ?? []

  const { tests, assertions } = collectTests(featureDir)

  const breadth = computeCoverageLedger({ feature: args.feature, requirements, tests })
  const ledger = applyTestStrength(breadth, assertions)

  // --- State model (R3): summary × coverage axes + drift detail. ---
  const live = readDocsCollection(featureDir)
  const summaryDrifted = summary ? live.docsHash !== summary.docsHash : false
  const docsDelta = diffDocs(fingerprintDocs(live.entries), summary?.docFingerprints)
  const runState = readCoverageRunState(featureDir)
  const coverageStale = Boolean(
    runState && summary?.requirementsHash && runState.requirementsHash !== summary.requirementsHash,
  )
  // A running background job (R4) overlays the persisted state with GENERATING.
  const jobStore = new CoverageJobRunStore(args.logsDir)
  const activeJob: DeriveStateInput['activeJob'] = jobStore.activeFor(args.feature, 'summary')
    ? 'summary'
    : jobStore.activeFor(args.feature, 'coverage')
      ? 'coverage'
      : null
  const stateInput: DeriveStateInput = {
    hasSummary: Boolean(summary),
    summaryDrifted,
    changedDocs: summaryDrifted ? changedDocPaths(docsDelta) : [],
    hasAnnotatedTests: tests.some((t) => (t.requirements?.length ?? 0) > 0),
    coverageStale,
    coveragePct: ledger.coveragePct,
    activeJob,
  }
  ledger.state = deriveCoverageStateView(stateInput)
  ledger.docsDrift = summaryDrifted // back-compat mirror
  return ledger
}

// Legacy review-queue sidecar (removed with the accept/reject flow). Still named
// here so `clearPrdSummary` cleans up any file left by an older build.
const LEGACY_MAPPINGS_JSON = '_coverage-mappings.json'

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
function applyTagToFile(
  featureDir: string,
  relFile: string,
  testName: string,
  requirements: string[],
  pathTypes: ProposedMapping['pathTypes'],
): boolean {
  const abs = path.join(featureDir, relFile)
  if (!fs.existsSync(abs)) return false
  const source = fs.readFileSync(abs, 'utf-8')
  const next = writeCoversTag(source, testName, { requirements, pathTypes })
  if (next === source) return false
  fs.writeFileSync(abs, next)
  return true
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
  const engineInputs: AnnotateTestInput[] = collected.map((c) => ({
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
    { requirements: candidateRequirements, tests: engineInputs, adapter: args.adapter, featureDir, cwd: args.cwd, signal: args.signal, onOutput: args.onOutput, onSession: args.onAgentSession },
  )

  // No review gate (R16): every inferred mapping's `covers` tag is written now.
  // Agent proposals report only a testName (the agent reads the spec but doesn't
  // echo its path), so backfill `file` by name from the engine's orphan inputs —
  // without this the entire agentic mapping path is a no-op at tag-writing.
  const fileByTestName = new Map(engineInputs.map((t) => [t.name, t.file]))
  const applied: ProposedMapping[] = []
  for (const m of proposals) {
    const file = m.file ?? fileByTestName.get(m.testName)
    if (!file) continue
    if (applyTagToFile(featureDir, file, m.testName, m.requirements, m.pathTypes)) applied.push({ ...m, file })
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
  const prompt = buildAnnotatePrompt(summary?.requirements ?? [], engineInputs, featureDir)
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

  const applied: ProposedMapping[] = []
  for (const m of args.mappings) {
    const requirementsFiltered = (m.requirements ?? []).filter((id) => knownIds.has(id))
    if (!requirementsFiltered.length) continue
    const file = m.file ?? fileByTestName.get(m.testName)
    if (!file) continue // unknown test name → not a mapping
    if (applyTagToFile(featureDir, file, m.testName, requirementsFiltered, m.pathTypes)) {
      applied.push({ ...m, requirements: requirementsFiltered, file })
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

export interface FeatureDoc {
  relPath: string
  /** Absolute path on disk — used to open the doc in the configured editor. */
  absPath: string
  /** A generated PRD artifact (`_prd-*`) vs a source doc the user added. */
  generated: boolean
  sizeBytes: number
}

export interface FeatureDocsListing {
  feature: string
  docs: FeatureDoc[]
  hasPrdSummary: boolean
  prdSummaryGeneratedAt?: string
  /** Source-doc count (excludes generated artifacts). */
  sourceDocCount: number
  docsDrift: boolean
}

export function listFeatureDocs(featuresDir: string, feature: string): FeatureDocsListing {
  const featureDir = resolveFeatureDir(featuresDir, feature)
  const docsDir = docsDirFor(featureDir)
  const docs: FeatureDoc[] = []
  if (fs.existsSync(docsDir)) {
    for (const name of fs.readdirSync(docsDir).sort()) {
      const full = path.join(docsDir, name)
      if (!fs.statSync(full).isFile() || !name.toLowerCase().endsWith('.md')) continue
      docs.push({ relPath: name, absPath: path.resolve(full), generated: isGeneratedDoc(name), sizeBytes: fs.statSync(full).size })
    }
  }
  const summary = readPrdSummary(featureDir)
  const sourceDocCount = docs.filter((d) => !d.generated).length
  return {
    feature,
    docs,
    hasPrdSummary: Boolean(summary),
    prdSummaryGeneratedAt: summary?.generatedAt,
    sourceDocCount,
    docsDrift: isDrifted(featureDir, summary),
  }
}

export interface RegeneratePrdSummaryArgs {
  featuresDir: string
  feature: string
  adapter?: SummarizeAdapter
  cwd?: string
  now?: string
  onOutput?: (chunk: string) => void
  onAgentSession?: (session: CoverageAgentSession) => void
}

export interface RegeneratePrdSummaryResult {
  feature: string
  summary: PrdSummary
  /** Relative paths of the written generated artifacts. */
  written: string[]
}

/** Test seam: inject a fake summarizer so unit tests don't spawn a real agent
 *  (production always uses the real, agent-backed `summarizePrd`). */
export interface RegeneratePrdSummaryDeps {
  summarize?: typeof summarizePrd
}

/**
 * Regenerate the PRD summary from the current source docs, preserving existing
 * requirement ids (the spine). Writes the sidecar + markdown back into docs/.
 */
export async function regeneratePrdSummary(
  args: RegeneratePrdSummaryArgs,
  deps: RegeneratePrdSummaryDeps = {},
): Promise<RegeneratePrdSummaryResult> {
  const found = loadFeatures(args.featuresDir).find((f) => f.name === args.feature)
  if (!found || !found.featureDir) throw new FeatureNotFoundError(args.feature)
  const featureDir = found.featureDir

  const summarize = deps.summarize ?? summarizePrd
  const collection = readDocsCollection(featureDir)
  const previous = readPrdSummary(featureDir)
  const summary = await summarize({
    collection,
    previous,
    adapter: args.adapter,
    cwd: args.cwd,
    now: args.now,
    onOutput: args.onOutput,
    onSession: args.onAgentSession,
  })
  const written = writePrdSummary(featureDir, found.name, summary)
  return {
    feature: args.feature,
    summary: written,
    written: [path.join('docs', PRD_SUMMARY_JSON), path.join('docs', PRD_SUMMARY_MD)],
  }
}

/**
 * Reset a feature's coverage to a blank slate: remove the generated PRD summary
 * and the coverage sidecars tied to it (run-state, pending mappings) AND strip
 * the `@req-*` / `@path-*` tags the engine wrote into the spec files. Source docs
 * (the uploaded PRD docs) are untouched; only the generated summary + the
 * coverage-owned tags in test specs are cleared. Without the tag strip, those
 * annotations would survive the reset and immediately read as "stale" (their
 * requirement ids no longer exist) — tag-writes are additive, so nothing else
 * ever removes them. After this the summary state returns to ABSENT and, if no
 * source docs remain, the whole surface is back to its initial empty state.
 */
export function clearPrdSummary(args: { featuresDir: string; feature: string }): { feature: string; removed: string[]; untagged: string[] } {
  const featureDir = resolveFeatureDir(args.featuresDir, args.feature)
  const docsDir = docsDirFor(featureDir)
  const removed: string[] = []
  for (const name of [PRD_SUMMARY_JSON, PRD_SUMMARY_MD, LEGACY_MAPPINGS_JSON, COVERAGE_STATE_JSON]) {
    const p = path.join(docsDir, name)
    if (fs.existsSync(p)) { fs.rmSync(p); removed.push(name) }
  }
  const untagged: string[] = []
  for (const file of listSpecFiles(featureDir)) {
    let source = ''
    try { source = fs.readFileSync(file, 'utf-8') } catch { continue }
    const next = stripCoverageTags(source)
    if (next !== source) {
      fs.writeFileSync(file, next)
      untagged.push(path.relative(featureDir, file))
    }
  }
  return { feature: args.feature, removed, untagged: untagged.sort() }
}

export { GENERATED_DOC_PREFIX }
