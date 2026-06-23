// TEST FIXTURE — not production code. Production coverage generation is LLM-only
// (an agent reads the docs / test bodies and reasons). Unit tests can't spawn a
// real agent, so they inject these fakes through the `summarize` / `propose` deps
// seams on regeneratePrdSummary / runCoverageEngine. The fakes reproduce the old
// deterministic heuristics (heading-extraction for the summary, token-overlap for
// the mapping) purely so existing doc-derived assertions keep working — they are
// NOT a fallback the app ever uses.

import type { DocsCollection } from '../docs-collection'
import { reconcileRequirementIds, type ParsedRequirement, type SummarizePrdArgs, type SummarizePrdDeps } from '../prd-summary'
import type { AnnotateTestInput, ProposeMappingsArgs, ProposeMappingsDeps } from '../annotate-engine'
import { withFingerprints } from '../fingerprints'
import type { PrdSummary, ProposedMapping, Requirement } from '../../../../../../../shared/coverage/types'

// --- Summary: one requirement per markdown heading ------------------------------

function extractRawRequirements(collection: DocsCollection): Array<{ title: string; text: string }> {
  const raw: Array<{ title: string; text: string }> = []
  for (const entry of collection.entries) {
    const lines = entry.content.split(/\r?\n/)
    const headingIdxs: number[] = []
    lines.forEach((line, i) => {
      if (/^#{1,6}\s+\S/.test(line)) headingIdxs.push(i)
    })
    if (!headingIdxs.length) {
      const firstBody = lines.find((l) => l.trim())?.trim()
      raw.push({ title: entry.relPath.replace(/\.md$/i, ''), text: firstBody || entry.relPath })
      continue
    }
    headingIdxs.forEach((start, n) => {
      const endLine = headingIdxs[n + 1] ?? lines.length
      const title = lines[start].replace(/^#{1,6}\s+/, '').trim()
      const body = lines.slice(start + 1, endLine).map((l) => l.trim()).filter(Boolean).join(' ')
      raw.push({ title, text: body || title })
    })
  }
  return raw
}

/** Requirements from headings, with stable ids — the test-fixture equivalent of an
 *  agent summary. Exported for the fixture's own unit test. */
export function fakeRequirementsFromDocs(collection: DocsCollection, previous: Requirement[]): Requirement[] {
  const parsed: ParsedRequirement[] = extractRawRequirements(collection).map((r) => ({
    title: r.title,
    text: r.text,
    pathTypes: ['happy'],
  }))
  return reconcileRequirementIds(previous, parsed)
}

/** Drop-in for `summarizePrd` (signature-compatible) used by tests via the
 *  `summarize` dep seam. Ignores `deps` (no agent). */
export async function fakeSummarize(args: SummarizePrdArgs, _deps?: SummarizePrdDeps): Promise<PrdSummary> {
  const previous = args.previous?.requirements ?? []
  const requirements = fakeRequirementsFromDocs(args.collection, previous)
  const summary: PrdSummary = {
    requirements,
    docsHash: args.collection.docsHash,
    sourceDocs: args.collection.entries.map((e) => e.relPath),
    generatedAt: args.now ?? '2026-01-01T00:00:00.000Z',
  }
  return withFingerprints(summary, args.collection.entries)
}

// --- Mapping: best requirement per test by token overlap ------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'are', 'be', 'in', 'on', 'for',
  'with', 'that', 'this', 'it', 'as', 'by', 'from', 'should', 'must', 'when', 'then',
  'test', 'tests', 'verify', 'verifies', 'check', 'checks', 'via',
])

function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const t = raw.trim()
    if (t.length >= 3 && !STOP_WORDS.has(t)) out.add(t)
  }
  return out
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/** Map each test to its single best-matching requirement by token overlap.
 *  Exported for the fixture's own unit test. */
export function fakeMappingsFor(requirements: Requirement[], tests: AnnotateTestInput[], threshold = 0.3): ProposedMapping[] {
  const active = requirements.filter((r) => !r.deprecated)
  const reqTokens = active.map((r) => ({ req: r, tokens: tokenize(`${r.title} ${r.text}`) }))
  const out: ProposedMapping[] = []
  for (const test of tests) {
    const testTokens = tokenize(`${test.name} ${test.bodySource ?? ''}`)
    let best: { id: string; score: number } | null = null
    for (const { req, tokens } of reqTokens) {
      const score = overlapScore(testTokens, tokens)
      if (score > 0 && (!best || score > best.score)) best = { id: req.id, score }
    }
    if (best && best.score >= threshold) {
      out.push({
        testName: test.name,
        file: test.file,
        requirements: [best.id],
        pathTypes: ['happy'],
        rationale: `token overlap ${Math.round(best.score * 100)}% with requirement ${best.id}`,
        confidence: Math.round(best.score * 100) / 100,
        source: 'deterministic',
      })
    }
  }
  return out
}

/** Drop-in for `proposeCoverageMappings` (signature-compatible) used by tests via
 *  the `propose` dep seam. Ignores `deps` (no agent). */
export async function fakePropose(args: ProposeMappingsArgs, _deps?: ProposeMappingsDeps): Promise<ProposedMapping[]> {
  return fakeMappingsFor(args.requirements, args.tests)
}
