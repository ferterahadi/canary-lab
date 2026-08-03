// Turning a Playwright run's summary + manifest into a verdict: pass counts,
// rerun/verification plans, failure extraction, and the final run status.
//
// Split out of orchestrator.ts. These are pure functions over the summary
// shape, which is what lets them be unit-tested directly against fixtures —
// the run loop's evidence must not rest on paths only reachable by driving a
// live orchestrator. Stays in logic/runtime/ deliberately: sibling modules
// here resolve paths via __dirname.

import fs from 'fs'
import { type RunLifecycleTargetedRerun } from './manifest'
import { slugify } from './summary-reporter'
import { listSpecFiles } from '../../../../shared/feature-loader'
import { extractTestsFromSource } from '../../../../shared/ast-extractor'
import { SummaryShape, VerificationPlan, computedTotal, countPassed, extractFailedSlugs } from './run-verdict'

export type PlaywrightRerunSelection =
  | {
      kind: 'targets'
      targets: readonly string[]
      selected: number
      total: number
      mode: RunLifecycleTargetedRerun['mode']
      reason: string
    }
  | {
      kind: 'grep'
      grep: string
      selected: number
      total: number
      mode: RunLifecycleTargetedRerun['mode']
      reason: string
    }
  // Preferred over `grep` whenever every selected test carries a `listLine`.
  // `--grep` matches on TITLE only, so two tests sharing a title in different
  // spec files both run even when the plan selected one — measured against
  // Playwright 1.62: an escaped grep for a duplicated title selects 2 tests in
  // 2 files, while the equivalent test list selects exactly 1.
  | {
      kind: 'test-list'
      testList: readonly string[]
      selected: number
      total: number
      mode: RunLifecycleTargetedRerun['mode']
      reason: string
    }

export interface KnownSummaryTest {
  name: string
  title: string
  titlePath?: string[]
  /** The test as Playwright's `--list` renders it, captured by the summary
   *  reporter. Present only for summaries written after `--test-list` support
   *  landed; absent on older ones, which fall back to `--grep`. */
  listLine?: string
  location?: string
}

export type NonPassedTargetsResult =
  | { kind: 'targeted'; locations: string[]; total: number }
  | { kind: 'all-passed'; total: number }
  | { kind: 'no-passed-yet'; total: number }
  | { kind: 'extraction-failed' }

export type RerunTargetsOrderedResult =
  | {
      kind: 'targeted'
      locations: string[]
      failedFirst: string[]
      skipped: string[]
      pending: string[]
      droppedFailedSlugs: string[]
      total: number
    }
  | { kind: 'all-passed'; total: number }
  | { kind: 'extraction-failed' }

// Compute the ordered list of file:line locations for a post-heal rerun:
// previously-failed tests FIRST (so we verify the fix landed), then anything
// still pending in source order. Failed locations are looked up by slug in the
// CURRENT AST so the rerun resolves correctly even if the heal agent moved
// the test to a new line. Slugs that no longer exist in the AST (the agent
// renamed or deleted the test) are reported via `droppedFailedSlugs` so the
// caller can surface a lifecycle warning instead of silently shipping a
// `file:line` that Playwright will report as "no tests found".
export function computeRerunTargetsOrdered(
  featureDir: string,
  summary: SummaryShape,
): RerunTargetsOrderedResult {
  const files = listSpecFiles(featureDir)
  if (files.length === 0) return { kind: 'extraction-failed' }

  const allTests: Array<{ location: string; slug: string }> = []
  let parsedAny = false
  for (const file of files) {
    let source = ''
    try { source = fs.readFileSync(file, 'utf-8') } catch { continue }
    const result = extractTestsFromSource(file, source)
    if (result.parseError && result.tests.length === 0) continue
    parsedAny = true
    for (const t of result.tests) {
      allTests.push({
        location: `${file}:${t.line}`,
        slug: `test-case-${slugify(t.name)}`,
      })
    }
  }
  if (!parsedAny || allTests.length === 0) return { kind: 'extraction-failed' }

  const locationBySlug = new Map<string, string>()
  for (const t of allTests) {
    if (!locationBySlug.has(t.slug)) locationBySlug.set(t.slug, t.location)
  }

  const passedRaw = Array.isArray(summary.passedNames) ? summary.passedNames : []
  const passed = new Set(passedRaw.filter((n): n is string => typeof n === 'string'))
  const skipped = skippedNameSet(summary)

  const failedSlugs = extractFailedSlugs(summary)
  const failedFirstSlugs = new Set<string>()
  const failedFirst: string[] = []
  const droppedFailedSlugs: string[] = []
  for (const slug of failedSlugs) {
    if (passed.has(slug)) continue // recovered between snapshots
    if (failedFirstSlugs.has(slug)) continue
    const loc = locationBySlug.get(slug)
    if (!loc) {
      droppedFailedSlugs.push(slug)
      continue
    }
    failedFirstSlugs.add(slug)
    failedFirst.push(loc)
  }

  const skippedLocations: string[] = []
  const seenLocations = new Set<string>(failedFirst)
  for (const t of allTests) {
    if (passed.has(t.slug)) continue
    if (failedFirstSlugs.has(t.slug)) continue
    if (!skipped.has(t.slug)) continue
    if (seenLocations.has(t.location)) continue
    seenLocations.add(t.location)
    skippedLocations.push(t.location)
  }

  const pending: string[] = []
  for (const t of allTests) {
    if (passed.has(t.slug)) continue
    if (failedFirstSlugs.has(t.slug)) continue
    if (skipped.has(t.slug)) continue
    if (seenLocations.has(t.location)) continue
    seenLocations.add(t.location)
    pending.push(t.location)
  }

  if (failedFirst.length === 0 && skippedLocations.length === 0 && pending.length === 0) {
    return { kind: 'all-passed', total: allTests.length }
  }
  return {
    kind: 'targeted',
    locations: [...failedFirst, ...skippedLocations, ...pending],
    failedFirst,
    skipped: skippedLocations,
    pending,
    droppedFailedSlugs,
    total: allTests.length,
  }
}

// Compute file:line locations for every test that has NOT yet passed in the
// given summary — i.e. the union of failed + pending. Used on heal restart so
// the agent re-runs everything still outstanding, not just the ones that
// failed last cycle. Returns a discriminated result so the caller can decide
// whether to skip the targeted rerun (full-suite is equivalent or no work to
// do) or fall back to legacy failed-only targeting on enumeration failure.
export function computeNonPassedTargets(
  featureDir: string,
  summary: SummaryShape,
): NonPassedTargetsResult {
  const files = listSpecFiles(featureDir)
  if (files.length === 0) return { kind: 'extraction-failed' }

  const allTests: Array<{ location: string; slug: string }> = []
  let parsedAny = false
  for (const file of files) {
    let source = ''
    try { source = fs.readFileSync(file, 'utf-8') } catch { continue }
    const result = extractTestsFromSource(file, source)
    if (result.parseError && result.tests.length === 0) continue
    parsedAny = true
    for (const t of result.tests) {
      allTests.push({
        location: `${file}:${t.line}`,
        slug: `test-case-${slugify(t.name)}`,
      })
    }
  }
  if (!parsedAny || allTests.length === 0) return { kind: 'extraction-failed' }

  const passedRaw = Array.isArray(summary.passedNames) ? summary.passedNames : []
  const passed = new Set(passedRaw.filter((n): n is string => typeof n === 'string'))

  if (passed.size === 0) return { kind: 'no-passed-yet', total: allTests.length }

  const seen = new Set<string>()
  const locations: string[] = []
  for (const t of allTests) {
    if (passed.has(t.slug)) continue
    if (seen.has(t.location)) continue
    seen.add(t.location)
    locations.push(t.location)
  }

  if (locations.length === 0) return { kind: 'all-passed', total: allTests.length }
  return { kind: 'targeted', locations, total: allTests.length }
}

export function knownTestsFromSummary(summary: SummaryShape): KnownSummaryTest[] {
  const raw = Array.isArray(summary.knownTests) ? summary.knownTests : []
  const out: KnownSummaryTest[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as {
      name?: unknown
      title?: unknown
      titlePath?: unknown
      listLine?: unknown
      location?: unknown
    }
    if (typeof value.name !== 'string' || value.name.length === 0) continue
    if (typeof value.title !== 'string' || value.title.length === 0) continue
    if (out.some((test) => test.name === value.name)) continue
    out.push({
      name: value.name,
      title: value.title,
      ...(Array.isArray(value.titlePath)
        ? { titlePath: value.titlePath.filter((part): part is string => typeof part === 'string' && part.length > 0) }
        : {}),
      ...(typeof value.listLine === 'string' && value.listLine.length > 0 ? { listLine: value.listLine } : {}),
      ...(typeof value.location === 'string' && value.location.length > 0 ? { location: value.location } : {}),
    })
  }
  return out
}

export function passedNameSet(summary: SummaryShape): Set<string> {
  const passedRaw = Array.isArray(summary.passedNames) ? summary.passedNames : []
  return new Set(passedRaw.filter((name): name is string => typeof name === 'string' && name.length > 0))
}

export function skippedNameSet(summary: SummaryShape): Set<string> {
  const skippedRaw = Array.isArray(summary.skippedNames) ? summary.skippedNames : []
  return new Set(skippedRaw.filter((name): name is string => typeof name === 'string' && name.length > 0))
}

export function summaryHasPassingEvidence(summary: SummaryShape): boolean {
  if (knownTestsFromSummary(summary).length > 0) return true
  const total = computedTotal(summary)
  return total > 0 && countPassed(summary) >= total
}

export function uniqueByName(tests: KnownSummaryTest[]): KnownSummaryTest[] {
  const seen = new Set<string>()
  const out: KnownSummaryTest[] = []
  for (const test of tests) {
    if (seen.has(test.name)) continue
    seen.add(test.name)
    out.push(test)
  }
  return out
}

/**
 * The `--test-list` lines for a selection, or `null` when even one selected test
 * lacks a `listLine`.
 *
 * All-or-nothing on purpose. A partial list would quietly run a subset of what
 * the plan selected, and the run's verdict would then be computed from a rerun
 * that skipped tests nobody chose to skip. Returning null hands the caller back
 * to `--grep`, which over-selects rather than under-selects — the safe direction
 * when we cannot be exact.
 *
 * `lines` is empty only when `tests` is (a non-empty selection either pushes a
 * line or returns null above), and `computeRerunTargetsOrdered` — the sole
 * caller — has already returned `all-passed` on an empty selection. So there is
 * no empty-result arm to guard: an added one would be dead code, and dead code
 * here is worse than none, because it would read as a live safety net.
 */
export function testListForKnownTests(tests: KnownSummaryTest[]): string[] | null {
  const lines: string[] = []
  for (const test of tests) {
    if (!test.listLine) return null
    if (!lines.includes(test.listLine)) lines.push(test.listLine)
  }
  return lines
}

// Always returns a usable selector: `knownTestsFromSummary` is the only source
// of a KnownSummaryTest and it drops any entry without a non-empty `title`, and
// the sole caller has already returned early on an empty selection. The return
// type says `string` so a future edit that breaks either invariant is a compile
// error rather than a silently-widened full-suite rerun.
export function grepForKnownTests(tests: KnownSummaryTest[]): string {
  const titles = Array.from(new Set(tests.map((test) => test.title)))
  const escaped = titles.map(escapeRegExp)
  return escaped.length === 1 ? escaped[0] : `(?:${escaped.join('|')})`
}

export function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

export function isSpecLocation(location: string): boolean {
  return /(?:\.spec\.[cm]?[jt]sx?|\.test\.[cm]?[jt]sx?):\d+(?::\d+)?$/.test(location)
}

export function selectionForPlan(plan: VerificationPlan): PlaywrightRerunSelection | undefined {
  return plan.kind === 'targeted' ? plan.selection : undefined
}

// Stable signature of the not-yet-passed test set a plan would re-run. Used by
// the auto-heal no-agent rerun branch to detect a no-progress cycle: if a rerun
// leaves this set unchanged, re-running again would produce the identical
// result (e.g. the only remaining tests are deterministically skipped via
// `test.skip(cond)`), so the loop must stop instead of spinning forever.
export function nonPassedSignatureFromPlan(plan: VerificationPlan): string {
  if (plan.kind === 'all-passed') return ''
  if (plan.kind === 'full-suite') return `full-suite:${plan.total}`
  return [...plan.failedFirst, ...plan.skipped, ...plan.pending]
    .map((test) => test.name)
    .sort()
    .join('|')
}

export function normalizeRerunSelection(rerun?: readonly string[] | PlaywrightRerunSelection): PlaywrightRerunSelection | undefined {
  if (!rerun) return undefined
  if (!Array.isArray(rerun)) return rerun as PlaywrightRerunSelection
  const targets = rerun as readonly string[]
  if (targets.length === 0) return undefined
  return {
    kind: 'targets',
    targets,
    selected: targets.length,
    total: targets.length,
    mode: 'failed-and-pending',
    reason: 'The runner selected tests that had not passed yet.',
  }
}
