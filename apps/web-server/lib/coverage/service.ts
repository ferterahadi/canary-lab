import fs from 'fs'
import path from 'path'
import { loadFeatures, listSpecFiles } from '../feature-loader'
import { extractTestsFromSource } from '../ast-extractor'
import type { CoverageLedger, PrdSummary } from '../../../../shared/coverage/types'
import { buildLastPassingRunIndex } from './grounding'
import { computeCoverageLedger, type CoverageTestInput } from './ledger'
import { applyRigor, type TestAssertions } from './rigor'
import {
  GENERATED_DOC_PREFIX,
  docsDirFor,
  isGeneratedDoc,
  readDocsCollection,
} from './docs-collection'
import {
  PRD_SUMMARY_JSON,
  PRD_SUMMARY_MD,
  readPrdSummary,
  summarizePrd,
  writePrdSummary,
  type SummarizeAdapter,
} from './prd-summary'

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

/** Merge per-test annotation/assertion data across all of a feature's specs. */
function collectTests(featureDir: string): { tests: CoverageTestInput[]; assertions: TestAssertions[] } {
  const byName = new Map<string, { input: CoverageTestInput; assertions: Set<string> }>()
  for (const file of listSpecFiles(featureDir)) {
    let source = ''
    try { source = fs.readFileSync(file, 'utf-8') } catch { continue }
    const extracted = extractTestsFromSource(file, source)
    for (const t of extracted.tests) {
      const existing = byName.get(t.name)
      if (existing) {
        // Same test name in two specs — union the linkage, concat assertions.
        if (t.requirements) existing.input.requirements = [...new Set([...(existing.input.requirements ?? []), ...t.requirements])]
        if (t.pathTypes) existing.input.pathTypes = [...new Set([...(existing.input.pathTypes ?? []), ...t.pathTypes])]
        for (const a of t.assertions ?? []) existing.assertions.add(a)
        continue
      }
      byName.set(t.name, {
        input: {
          name: t.name,
          requirements: t.requirements,
          pathTypes: t.pathTypes,
          file: path.relative(featureDir, t.sourceFile ?? file),
          line: t.line,
        },
        assertions: new Set(t.assertions ?? []),
      })
    }
  }
  const tests: CoverageTestInput[] = []
  const assertions: TestAssertions[] = []
  for (const { input, assertions: set } of byName.values()) {
    tests.push(input)
    assertions.push({ name: input.name, assertions: [...set] })
  }
  return { tests, assertions }
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
  const index = buildLastPassingRunIndex(args.logsDir, args.feature)

  const breadth = computeCoverageLedger({ feature: args.feature, requirements, tests, index })
  const ledger = applyRigor(breadth, requirements, assertions)
  ledger.docsDrift = isDrifted(featureDir, summary)
  return ledger
}

export interface FeatureDoc {
  relPath: string
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
      docs.push({ relPath: name, generated: isGeneratedDoc(name), sizeBytes: fs.statSync(full).size })
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
}

export interface RegeneratePrdSummaryResult {
  feature: string
  summary: PrdSummary
  /** Relative paths of the written generated artifacts. */
  written: string[]
}

/**
 * Regenerate the PRD summary from the current source docs, preserving existing
 * requirement ids (the spine). Writes the sidecar + markdown back into docs/.
 */
export async function regeneratePrdSummary(args: RegeneratePrdSummaryArgs): Promise<RegeneratePrdSummaryResult> {
  const found = loadFeatures(args.featuresDir).find((f) => f.name === args.feature)
  if (!found || !found.featureDir) throw new FeatureNotFoundError(args.feature)
  const featureDir = found.featureDir

  const collection = readDocsCollection(featureDir)
  const previous = readPrdSummary(featureDir)
  const summary = await summarizePrd({
    collection,
    previous,
    adapter: args.adapter,
    cwd: args.cwd,
    now: args.now,
    onOutput: args.onOutput,
  })
  const written = writePrdSummary(featureDir, found.name, summary)
  return {
    feature: args.feature,
    summary: written,
    written: [path.join('docs', PRD_SUMMARY_JSON), path.join('docs', PRD_SUMMARY_MD)],
  }
}

export { GENERATED_DOC_PREFIX }
