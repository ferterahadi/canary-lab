import fs from 'fs'
import path from 'path'
import { loadFeatures, listSpecFiles } from '../../../../shared/feature-loader'
import { extractTestsFromSource } from '../../../../shared/ast-extractor'
import type { CoverageLedger, PrdSummary, Requirement } from '../../../../../../../shared/coverage/types'
import { computeCoverageLedger, type CoverageTestInput } from './ledger'
import { lastRunOutcomeForTitle, readLatestRunOutcomes } from '../../../runs/logic/runtime/run-outcomes'
import { applyTestStrength, type TestAssertions } from './strength'
import { changedDocPaths, diffDocs, fingerprintDocs } from './fingerprints'
import { deriveCoverageStateView, type DeriveStateInput } from './state'
import { readCoverageRunState } from './run-state'
import { coverageJobStore } from './jobs/store'
import { GENERATED_DOC_PREFIX, readDocsCollection } from './docs-collection'
import { readPrdSummary } from './prd-summary'

export { LEGACY_MAPPINGS_JSON, applyExternalCoverageMappings, buildCoverageMappingContext, flagMappingIssues, hasPrdSummary, runCoverageEngine } from './coverage-engine'
export type { ApplyExternalCoverageArgs, ApplyExternalCoverageResult, CoverageMappingContext, CoverageMappingTest, MappingTestSource, RunCoverageEngineArgs, RunCoverageEngineDeps, RunCoverageEngineResult } from './coverage-engine'
export { applyExternalSummary, buildSummaryAuthoringContext, clearPrdSummary, listFeatureDocs, regeneratePrdSummary } from './feature-docs'
export type { ApplyExternalSummaryArgs, ApplyExternalSummaryResult, BuildSummaryAuthoringResult, FeatureDoc, FeatureDocsListing, RegeneratePrdSummaryArgs, RegeneratePrdSummaryDeps, RegeneratePrdSummaryResult, SummaryAuthoringContext, SummaryAuthoringDoc } from './feature-docs'

// The single computation layer for the Requirement Coverage Ledger. Both the REST
// route (routes/coverage.ts) and the MCP tools (mcp/tools.ts) call these — so
// the UI and an agent always see the same numbers (dual-surface parity).

export class FeatureNotFoundError extends Error {
  constructor(public readonly feature: string) {
    super(`feature not found: ${feature}`)
    this.name = 'FeatureNotFoundError'
  }
}

export function resolveFeatureDir(featuresDir: string, feature: string): string {
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
export function collectTests(featureDir: string): CollectedTests {
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
        existing.input.variants = unionList(existing.input.variants, t.variants)
        for (const a of t.assertions ?? []) existing.assertions.add(a)
        continue
      }
      byName.set(t.name, {
        input: {
          name: t.name,
          requirements: t.requirements,
          pathTypes: t.pathTypes,
          variants: t.variants,
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

export function isDrifted(featureDir: string, summary: PrdSummary | null): boolean {
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
  /** Pre-resolved feature directory. Callers already holding the loaded feature
   *  list pass it so this doesn't re-`loadFeatures()` — which busts the require
   *  cache and re-compiles every `feature.config.cjs`. Looping the whole
   *  workspace without it cost 34 full loads per request (1122 requires for 33
   *  features). Omit it and the directory is resolved as before. */
  featureDir?: string
}

/** Assemble the full ledger (breadth + depth + drift) for one feature. */
export function computeFeatureCoverage(args: ComputeFeatureCoverageArgs): CoverageLedger {
  const featureDir = args.featureDir ?? resolveFeatureDir(args.featuresDir, args.feature)
  const summary = readPrdSummary(featureDir)
  const requirements = summary?.requirements ?? []

  const { tests, assertions } = collectTests(featureDir)

  // Proven axis: join each test's latest-run outcome (pass/fail) so the ledger
  // can distinguish "covered (claimed by a tag)" from "covered (proven by a
  // passing run)". Additive — gap types and coveragePct stay claim-based.
  const outcomes = readLatestRunOutcomes(args.logsDir, args.feature)
  if (outcomes) {
    for (const t of tests) {
      const lastRun = lastRunOutcomeForTitle(outcomes, t.name)
      if (lastRun) t.lastRun = lastRun
    }
  }

  const breadth = computeCoverageLedger({
    feature: args.feature,
    requirements,
    tests,
    ...(outcomes ? { provenRunId: outcomes.runId } : {}),
  })
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
  const jobStore = coverageJobStore(args.logsDir)
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

export { GENERATED_DOC_PREFIX }
