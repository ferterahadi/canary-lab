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
import { type RunLifecyclePhase, type RunManifest, type StoppedEarlyReason } from './manifest'
import { loadFeatures } from '../../../../shared/feature-loader'
import { KnownSummaryTest, PlaywrightRerunSelection, computeRerunTargetsOrdered, expandForSerialSpecs, grepForKnownTests, isSpecLocation, knownTestsFromSummary, passedNameSet, serialSpecFiles, skippedNameSet, testListForKnownTests, uniqueByName } from './rerun-targets'

export { computeNonPassedTargets, computeRerunTargetsOrdered, nonPassedSignatureFromPlan, normalizeRerunSelection, selectionForPlan, summaryHasPassingEvidence } from './rerun-targets'
export type { NonPassedTargetsResult, PlaywrightRerunSelection, RerunTargetsOrderedResult } from './rerun-targets'

export interface SummaryShape {
  failed?: Array<{ name?: unknown; endTime?: unknown; location?: unknown }>
  passed?: unknown
  passedNames?: unknown
  skippedNames?: unknown
  total?: unknown
  knownTests?: unknown
}

export function countPassed(summary: SummaryShape): number {
  return typeof summary.passed === 'number' ? summary.passed : 0
}

export function computedTotal(summary: SummaryShape): number {
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

// Used wherever a serial spec makes a targeted selection unsound and the only
// safe answer is to run everything. See `serialSpecFiles` for why a serial
// group's tests cannot be re-run apart.
const SERIAL_FULL_SUITE_REASON = 'This feature has a serial spec whose tests hand state to each other, and this rerun cannot select the group intact; running the full suite with the configured failure threshold.'

export function computeVerificationPlan(
  featureDir: string,
  summary: SummaryShape,
): VerificationPlan {
  const serialFiles = serialSpecFiles(featureDir)
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
    // A serial group can only be re-run intact when every selected test's file
    // is known. Summaries written before the reporter captured locations can't
    // say, so the whole suite runs rather than a selection that would fail on a
    // missing producer rather than on the app.
    if (serialFiles.size > 0 && selected.some((test) => !test.location)) {
      return { kind: 'full-suite', total: knownTests.length, reason: SERIAL_FULL_SUITE_REASON }
    }
    const { tests: runSet, companions } = expandForSerialSpecs(serialFiles, knownTests, selected)
    const passedCount = countPassed(summary)
    const failedCount = Array.isArray(summary.failed) ? summary.failed.length : 0
    const reason = `Rerunning ${selected.length} not-yet-passed tests (${failedFirst.length} failed first, then ${skipped.length} skipped, then ${pending.length} pending/not-run) because ${passedCount} passed and ${failedCount} failed before healing.`
      + (companions.length > 0
        ? ` Also re-running ${companions.length} already-passed test${companions.length === 1 ? '' : 's'} from the same serial spec file${companions.length === 1 ? '' : 's'}, because a serial group's tests hand state to each other and cannot run apart.`
        : '')
    // A test list names each test exactly; `--grep` matches on title alone and
    // would also run same-titled tests in other spec files. Older summaries
    // predate `listLine`, so grep stays as the fallback.
    const testList = testListForKnownTests(runSet)
    return {
      kind: 'targeted',
      selection: testList
        ? {
            kind: 'test-list',
            testList,
            selected: runSet.length,
            total: knownTests.length,
            mode: 'failed-and-pending',
            reason,
          }
        : {
            kind: 'grep',
            grep: grepForKnownTests(runSet),
            selected: runSet.length,
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
    // Both fallback paths select bare `file:line` targets and carry no per-test
    // identity to widen a selection with, so a serial group cannot be
    // reassembled here the way the inventory path above does it. Gated AFTER
    // each path's all-passed arm: widening a fully-passed summary into a
    // full-suite plan would turn a passing run into a failing one, since
    // `decideRunStatus` reads `all-passed` as the pass.
    if (serialFiles.size > 0) {
      return { kind: 'full-suite', total: computed.total, reason: SERIAL_FULL_SUITE_REASON }
    }
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
  if (serialFiles.size > 0) {
    return {
      kind: 'full-suite',
      total: computedTotal(summary) || failedSlugs.length,
      reason: SERIAL_FULL_SUITE_REASON,
    }
  }
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
