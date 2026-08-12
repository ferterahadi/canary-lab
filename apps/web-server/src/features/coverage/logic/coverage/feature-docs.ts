import fs from 'fs'
import path from 'path'
import { loadFeatures, listSpecFiles } from '../../../../shared/feature-loader'
import type { PrdSummary, VariantDimension } from '../../../../../../../shared/coverage/types'
import { type CoverageAgentSession } from './annotate-engine'
import { stripCoverageTags } from './tag-writer'
import { COVERAGE_STATE_JSON } from './run-state'
import { docsDirFor, isGeneratedDoc, readDocsCollection } from './docs-collection'
import {
  PRD_SUMMARY_JSON,
  PRD_SUMMARY_MD,
  assembleSummary,
  buildPrdSummaryPrompt,
  readPrdSummary,
  summarizePrd,
  writePrdSummary,
  type ParsedRequirement,
  type SummarizeAdapter,
} from './prd-summary'
import { LEGACY_MAPPINGS_JSON, hasPrdSummary } from './coverage-engine'
import { FeatureNotFoundError, isDrifted, resolveFeatureDir } from './service'

// ---------------------------------------------------------------------------
// External (offloaded) PRD summary — the SAME summarization exercise, but the
// calling MCP client reads the source docs and proposes the requirements itself
// (no Canary-spawned agent). buildSummaryAuthoringContext hands the client the
// prompt; the client returns `requirements`; applyExternalSummary reconciles ids
// + writes the sidecar through the canonical assembler — so the offload path
// never re-implements the prompt OR the id spine. Mirrors the external-coverage
// pair above.
// ---------------------------------------------------------------------------

export interface SummaryAuthoringDoc {
  relPath: string
  /** Absolute path the client should read before proposing requirements. */
  absPath: string
}

export interface SummaryAuthoringContext {
  feature: string
  /** The source docs to read (their absolute paths are embedded in the prompt). */
  docs: SummaryAuthoringDoc[]
  /** Previous requirement ids to PRESERVE — the stable spine inline @requirement
   *  annotations point at. Reuse a surviving id rather than minting a new one. */
  previousRequirementIds: string[]
  /** The full summarization prompt (instructions + doc paths + previous ids + the
   *  expected `{ requirements: [...] }` output shape) — hand to the client
   *  verbatim. Reuses the internal summarizer prompt so both surfaces agree. */
  prompt: string
}

export type BuildSummaryAuthoringResult =
  | { kind: 'needs-docs'; feature: string }
  | { kind: 'ok'; context: SummaryAuthoringContext }

/** Assemble the read-only context an offloaded client needs to summarize the PRD.
 *  Returns `needs-docs` (no context) when the feature has no source docs to read.
 *  Throws FeatureNotFoundError for an unknown feature. */
export function buildSummaryAuthoringContext(args: { featuresDir: string; feature: string }): BuildSummaryAuthoringResult {
  const featureDir = resolveFeatureDir(args.featuresDir, args.feature)
  const collection = readDocsCollection(featureDir)
  if (collection.entries.length === 0) return { kind: 'needs-docs', feature: args.feature }
  const previous = readPrdSummary(featureDir)
  return {
    kind: 'ok',
    context: {
      feature: args.feature,
      docs: collection.entries.map((e) => ({ relPath: e.relPath, absPath: path.join(collection.docsDir, e.relPath) })),
      previousRequirementIds: (previous?.requirements ?? []).map((r) => r.id),
      prompt: buildPrdSummaryPrompt(collection, previous?.requirements ?? [], previous?.variantDimension),
    },
  }
}

export interface ApplyExternalSummaryArgs {
  featuresDir: string
  feature: string
  requirements: ParsedRequirement[]
  /** The feature's variant dimension (D1), as declared by the external agent. */
  variantDimension?: VariantDimension
  now?: string
}

export interface ApplyExternalSummaryResult {
  feature: string
  summary: PrdSummary
  /** Relative paths of the written generated artifacts. */
  written: string[]
}

/** Apply a client-supplied requirement list: reconcile ids against the prior
 *  summary (the spine) and write the sidecar + markdown through the canonical
 *  assembler/writer. Mirrors the write-tail of `regeneratePrdSummary` but spawns
 *  NO agent — the summarization already happened on the client. */
export function applyExternalSummary(args: ApplyExternalSummaryArgs): ApplyExternalSummaryResult {
  const found = loadFeatures(args.featuresDir).find((f) => f.name === args.feature)
  if (!found || !found.featureDir) throw new FeatureNotFoundError(args.feature)
  const featureDir = found.featureDir
  const collection = readDocsCollection(featureDir)
  const previous = readPrdSummary(featureDir)
  const summary = assembleSummary(collection, previous, args.requirements, args.variantDimension, args.now)
  const written = writePrdSummary(featureDir, found.name, summary)
  return {
    feature: args.feature,
    summary: written,
    written: [path.join('docs', PRD_SUMMARY_JSON), path.join('docs', PRD_SUMMARY_MD)],
  }
}

export interface FeatureDoc {
  relPath: string
  /** Absolute path on disk — used to open the doc in the configured editor. */
  absPath: string
  /** A generated PRD artifact (`_prd-*`) vs a source doc the user added. */
  generated: boolean
  sizeBytes: number
  /** A symlink to a doc that lives elsewhere (the user's original is the live
   *  source). Absent for plain files. */
  linked?: boolean
  /** The symlink's target, when linked (shown in the docs UI tooltip). */
  linkTarget?: string
  /** A symlink whose target no longer exists — surfaced, never crashed on. */
  broken?: boolean
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
      if (!/\.(md|markdown|txt)$/i.test(name)) continue
      // lstat first: a dangling symlink (its target moved) must be listed as
      // broken, not crash the whole docs rail.
      const lst = fs.lstatSync(full)
      const isLink = lst.isSymbolicLink()
      let stat: fs.Stats | null = null
      try {
        stat = fs.statSync(full)
      } catch {
        /* dangling symlink */
      }
      if (stat && !stat.isFile()) continue
      docs.push({
        relPath: name,
        absPath: path.resolve(full),
        generated: isGeneratedDoc(name),
        sizeBytes: stat?.size ?? 0,
        ...(isLink
          ? {
              linked: true,
              linkTarget: (() => {
                try {
                  return fs.readlinkSync(full)
                } catch {
                  return undefined
                }
              })(),
              ...(stat ? {} : { broken: true }),
            }
          : {}),
      })
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
  /** Cancels the summarizing agent's process. Without it a flight paused during
   *  the Requirements step left its agent running to completion, because this
   *  was the one link in the chain that dropped the signal — `summarizePrd`
   *  already stops the child on abort. */
  signal?: AbortSignal
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
    signal: args.signal,
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
