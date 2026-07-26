// Turning a Playwright run's summary + manifest into a verdict: pass counts,
// rerun/verification plans, failure extraction, and the final run status.
//
// Split out of orchestrator.ts. These are pure functions over the summary
// shape, which is what lets them be unit-tested directly against fixtures —
// the run loop's evidence must not rest on paths only reachable by driving a
// live orchestrator. Stays in logic/runtime/ deliberately: sibling modules
// here resolve paths via __dirname.

import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import {
  type RunLifecyclePhase,
  type RunLifecycleTargetedRerun,
  type RunManifest,
  type StoppedEarlyReason,
} from './manifest'
import { slugify } from './summary-reporter'
import { listSpecFiles, loadFeatures } from '../../../config/logic/feature-loader'
import { extractTestsFromSource } from '../../../config/logic/ast-extractor'

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

export interface SummaryShape {
  failed?: Array<{ name?: unknown; endTime?: unknown; location?: unknown }>
  passed?: unknown
  passedNames?: unknown
  skippedNames?: unknown
  total?: unknown
  knownTests?: unknown
}

interface KnownSummaryTest {
  name: string
  title: string
  titlePath?: string[]
  location?: string
}

export function countPassed(summary: SummaryShape): number {
  return typeof summary.passed === 'number' ? summary.passed : 0
}

function computedTotal(summary: SummaryShape): number {
  return typeof summary.total === 'number' ? summary.total : 0
}

export function signalLabel(kind: 'restart' | 'rerun' | 'heal'): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

export function startingServicesDetail(serviceCount: number): string {
  return serviceCount === 0
    ? 'No services are configured for this feature.'
    : `Starting ${serviceCount} service${serviceCount === 1 ? '' : 's'}.`
}

export function restartPlanDetail(restarted: string[], kept: string[], startedBecauseMissing: string[]): string {
  const parts: string[] = []
  if (restarted.length > 0) parts.push(`Restarting ${restarted.join(', ')}.`)
  if (kept.length > 0) parts.push(`Keeping warm ${kept.join(', ')}.`)
  if (startedBecauseMissing.length > 0) parts.push(`Will start missing kept service${startedBecauseMissing.length === 1 ? '' : 's'} ${startedBecauseMissing.join(', ')} before rerun.`)
  return parts.join(' ') || 'No service restart is required.'
}

export function finalLifecyclePhase(status: RunManifest['status']): RunLifecyclePhase {
  if (status === 'passed') return 'passed'
  if (status === 'aborted') return 'aborted'
  if (status === 'failed') return 'failed'
  return 'completed'
}

// Read just the `stoppedEarly.reason` field from a manifest on disk. Returns
// undefined if the manifest is missing, unparseable, or doesn't carry the
// field. Used by the heal loop to avoid clobbering an explicit 'user-pause'
// stamp with the automatic 'max-failures' attribution.
export function stoppedEarlyReasonOf(manifestPath: string): StoppedEarlyReason | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      stoppedEarly?: { reason?: StoppedEarlyReason }
    }
    return m.stoppedEarly?.reason
  } catch {
    return undefined
  }
}

export function readSummary(summaryPath: string): SummaryShape {
  try {
    return JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as SummaryShape
  } catch {
    return {}
  }
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

export type VerificationPlan =
  | {
      kind: 'targeted'
      selection: PlaywrightRerunSelection
      failedFirst: KnownSummaryTest[]
      skipped: KnownSummaryTest[]
      pending: KnownSummaryTest[]
      total: number
    }
  | { kind: 'full-suite'; reason: string; total: number }
  | { kind: 'all-passed'; total: number }

export function computeVerificationPlan(
  featureDir: string,
  summary: SummaryShape,
): VerificationPlan {
  const knownTests = knownTestsFromSummary(summary)
  if (knownTests.length > 0) {
    const passed = passedNameSet(summary)
    const skippedSet = skippedNameSet(summary)
    const failedSlugs = extractFailedSlugs(summary).filter((slug) => !passed.has(slug))
    const failedSet = new Set(failedSlugs)
    const knownByName = new Map(knownTests.map((test) => [test.name, test] as const))
    const missingFailed = failedSlugs.filter((slug) => !knownByName.has(slug))
    const failedFirst = uniqueByName(failedSlugs
      .map((slug) => knownByName.get(slug))
      .filter((test): test is KnownSummaryTest => Boolean(test)))
    const skipped = knownTests.filter((test) => !passed.has(test.name) && !failedSet.has(test.name) && skippedSet.has(test.name))
    const pending = knownTests.filter((test) => !passed.has(test.name) && !failedSet.has(test.name) && !skippedSet.has(test.name))
    const selected = [...failedFirst, ...skipped, ...pending]
    if (selected.length === 0) return { kind: 'all-passed', total: knownTests.length }
    if (missingFailed.length > 0) {
      return {
        kind: 'full-suite',
        total: knownTests.length,
        reason: `Post-heal rerun could not match ${missingFailed.length} failed test${missingFailed.length === 1 ? '' : 's'} in the known Playwright inventory; running the full suite with the configured failure threshold.`,
      }
    }
    const grep = grepForKnownTests(selected)
    const passedCount = countPassed(summary)
    const failedCount = Array.isArray(summary.failed) ? summary.failed.length : 0
    const reason = `Rerunning ${selected.length} not-yet-passed tests (${failedFirst.length} failed first, then ${skipped.length} skipped, then ${pending.length} pending/not-run) because ${passedCount} passed and ${failedCount} failed before healing.`
    return {
      kind: 'targeted',
      selection: {
        kind: 'grep',
        grep,
        selected: selected.length,
        total: knownTests.length,
        mode: 'failed-and-pending',
        reason,
      },
      failedFirst,
      skipped,
      pending,
      total: knownTests.length,
    }
  }

  const computed = computeRerunTargetsOrdered(featureDir, summary)
  if (computed.kind === 'all-passed') return { kind: 'all-passed', total: computed.total }
  if (computed.kind === 'targeted') {
    if (computed.droppedFailedSlugs.length > 0) {
      return {
        kind: 'full-suite',
        total: computed.total,
        reason: `Post-heal rerun could not safely target ${computed.droppedFailedSlugs.length} previously failed test${computed.droppedFailedSlugs.length === 1 ? '' : 's'} from static spec extraction; running the full suite with the configured failure threshold.`,
      }
    }
    const passedCount = countPassed(summary)
    const failedCount = Array.isArray(summary.failed) ? summary.failed.length : 0
    const reason = `Rerunning ${computed.locations.length} not-yet-passed tests (${computed.failedFirst.length} failed first, then ${computed.skipped.length} skipped, then ${computed.pending.length} pending/not-run) because ${passedCount} passed and ${failedCount} failed before healing.`
    return {
      kind: 'targeted',
      selection: {
        kind: 'targets',
        targets: computed.locations,
        selected: computed.locations.length,
        total: computed.total,
        mode: 'failed-and-pending',
        reason,
      },
      failedFirst: computed.failedFirst.map((location) => ({
        name: location,
        title: location,
        location,
      })),
      skipped: computed.skipped.map((location) => ({
        name: location,
        title: location,
        location,
      })),
      pending: computed.pending.map((location) => ({
        name: location,
        title: location,
        location,
      })),
      total: computed.total,
    }
  }

  const failedSlugs = extractFailedSlugs(summary)
  if (failedSlugs.length === 0) return { kind: 'all-passed', total: computedTotal(summary) }
  const locations = extractFailedLocations(summary)
  const canTargetEveryFailure = locations.length >= failedSlugs.length && locations.every(isSpecLocation)
  if (canTargetEveryFailure) {
    const reason = `Rerunning ${locations.length} failed test location${locations.length === 1 ? '' : 's'} from the summary because the full Playwright inventory is unavailable.`
    return {
      kind: 'targeted',
      selection: {
        kind: 'targets',
        targets: locations,
        selected: locations.length,
        total: computedTotal(summary) || locations.length,
        mode: 'failed-and-pending',
        reason,
      },
      failedFirst: locations.map((location) => ({ name: location, title: location, location })),
      skipped: [],
      pending: [],
      total: computedTotal(summary) || locations.length,
    }
  }
  return {
    kind: 'full-suite',
    total: computedTotal(summary) || failedSlugs.length,
    reason: 'Post-heal rerun has failed tests without a complete safe selector set; running the full Playwright suite with the configured failure threshold.',
  }
}

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

function knownTestsFromSummary(summary: SummaryShape): KnownSummaryTest[] {
  const raw = Array.isArray(summary.knownTests) ? summary.knownTests : []
  const out: KnownSummaryTest[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as {
      name?: unknown
      title?: unknown
      titlePath?: unknown
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
      ...(typeof value.location === 'string' && value.location.length > 0 ? { location: value.location } : {}),
    })
  }
  return out
}

function passedNameSet(summary: SummaryShape): Set<string> {
  const passedRaw = Array.isArray(summary.passedNames) ? summary.passedNames : []
  return new Set(passedRaw.filter((name): name is string => typeof name === 'string' && name.length > 0))
}

function skippedNameSet(summary: SummaryShape): Set<string> {
  const skippedRaw = Array.isArray(summary.skippedNames) ? summary.skippedNames : []
  return new Set(skippedRaw.filter((name): name is string => typeof name === 'string' && name.length > 0))
}

export function summaryHasPassingEvidence(summary: SummaryShape): boolean {
  if (knownTestsFromSummary(summary).length > 0) return true
  const total = computedTotal(summary)
  return total > 0 && countPassed(summary) >= total
}

function uniqueByName(tests: KnownSummaryTest[]): KnownSummaryTest[] {
  const seen = new Set<string>()
  const out: KnownSummaryTest[] = []
  for (const test of tests) {
    if (seen.has(test.name)) continue
    seen.add(test.name)
    out.push(test)
  }
  return out
}

// Always returns a usable selector: `knownTestsFromSummary` is the only source
// of a KnownSummaryTest and it drops any entry without a non-empty `title`, and
// the sole caller has already returned early on an empty selection. The return
// type says `string` so a future edit that breaks either invariant is a compile
// error rather than a silently-widened full-suite rerun.
function grepForKnownTests(tests: KnownSummaryTest[]): string {
  const titles = Array.from(new Set(tests.map((test) => test.title)))
  const escaped = titles.map(escapeRegExp)
  return escaped.length === 1 ? escaped[0] : `(?:${escaped.join('|')})`
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function isSpecLocation(location: string): boolean {
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

export function extractFailedSlugs(summary: SummaryShape): string[] {
  const failed = Array.isArray(summary.failed) ? summary.failed : []
  return failed
    .map((f) => (typeof f?.name === 'string' ? (f.name as string) : ''))
    .filter((n) => n.length > 0)
}

export function extractFailedLocations(summary: SummaryShape): string[] {
  const failed = Array.isArray(summary.failed) ? summary.failed : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of failed) {
    const location = typeof entry?.location === 'string' ? entry.location.trim() : ''
    if (!/:\d+(?::\d+)?$/.test(location)) continue
    if (seen.has(location)) continue
    seen.add(location)
    out.push(location)
  }
  return out
}

export function summarizeFailures(summaryPath: string): { failed: string[]; total: number } {
  const summary = readSummary(summaryPath)
  const failed = extractFailedSlugs(summary)
  const total = typeof summary.total === 'number' ? summary.total : failed.length
  return { failed, total }
}

export function readLatestHealOnFailureThreshold(feature: FeatureConfig): number | undefined {
  try {
    const featureDir = path.resolve(feature.featureDir)
    const latest = loadFeatures(path.dirname(featureDir))
      .find((candidate) => path.resolve(candidate.featureDir) === featureDir || candidate.name === feature.name)
    return latest ? latest.healOnFailureThreshold : feature.healOnFailureThreshold
  } catch {
    return feature.healOnFailureThreshold
  }
}

// PASSED only when (a) Playwright exited 0 AND (b) every known test is in
// summary.passedNames. The reporter's runtime `knownTests` inventory is the
// first source of truth so helper/factory-generated tests count; static spec
// extraction remains only as a legacy fallback.
export function decideRunStatus(
  featureDir: string,
  summaryPath: string,
  exitCode: number,
): 'passed' | 'failed' {
  if (exitCode !== 0) return 'failed'
  const summary = readSummary(summaryPath)
  return computeVerificationPlan(featureDir, summary).kind === 'all-passed' ? 'passed' : 'failed'
}
