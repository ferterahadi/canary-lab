import fs from 'fs'
import path from 'path'
import { readRunsIndex } from './manifest'
import { runDirFor } from './run-paths'
import { slugify } from './summary-reporter'

// Per-test outcomes of a feature's LATEST recorded run — the join source for
// the coverage ledger's `proven` axis ("covered by a test that actually
// passed", not just "a tag claims coverage"). Read-only over runs/index.json
// + the run's e2e-summary.json; no orchestrator state involved.

export interface LatestRunOutcomes {
  runId: string
  /** Summary slug names (`test-case-<slugified title>`) that passed. */
  passed: Set<string>
  /** Summary slug names that were still failing when the run ended. */
  failed: Set<string>
  /** Passed slugs whose pass needed a Playwright retry — flaky within the run.
   *  Carried so "every test passed" surfaces can say so instead of laundering a
   *  flaky pass into a clean one. */
  passedOnRetry: Set<string>
  /** The run's summary was seeded from a prior execution (a targeted heal rerun
   *  merges untouched results forward), so `passed` can span several partial
   *  executions rather than one clean run. */
  spansExecutions: boolean
}

/**
 * Find the newest run of `feature` (by startedAt in runs/index.json) whose
 * e2e-summary.json is readable, and return its per-test outcomes. Returns
 * null when the feature has no recorded run — callers then skip the proven
 * axis entirely rather than reporting everything unproven.
 *
 * Boot sessions and benchmark arms are excluded: a boot runs no tests, and a
 * benchmark run is an experiment, not evidence about the suite. A `verify` run
 * is deliberately NOT excluded — it executes the real suite against a live
 * environment, which is genuine proof; `provenRunId` attributes the join and
 * the UI caveats when it differs from the run being reported on.
 */
export function readLatestRunOutcomes(logsDir: string, feature: string): LatestRunOutcomes | null {
  const entries = readRunsIndex(logsDir)
    .filter((e) => e.feature === feature && e.executionType !== 'boot' && e.executionType !== 'benchmark')
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  for (const entry of entries) {
    const summaryPath = path.join(runDirFor(logsDir, entry.runId), 'e2e-summary.json')
    let parsed: { passedNames?: unknown; failed?: unknown; passedOnRetry?: unknown; mergedFromPriorExecution?: unknown }
    try {
      parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as typeof parsed
    } catch { continue }
    const passed = new Set(
      (Array.isArray(parsed.passedNames) ? parsed.passedNames : [])
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
    )
    const failed = new Set(
      (Array.isArray(parsed.failed) ? parsed.failed : [])
        .map((f) => (f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string'
          ? (f as { name: string }).name
          : ''))
        .filter((n) => n.length > 0),
    )
    const passedOnRetry = new Set(
      (Array.isArray(parsed.passedOnRetry) ? parsed.passedOnRetry : [])
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
    )
    return {
      runId: entry.runId,
      passed,
      failed,
      passedOnRetry,
      spansExecutions: parsed.mergedFromPriorExecution === true,
    }
  }
  return null
}

/**
 * Outcome of one spec test in that run, joined by title. Coverage tests are
 * keyed by the AST test title; the summary keys tests as
 * `test-case-${slugify(title)}` (the log-marker convention). Returns
 * undefined when the test didn't run (new, renamed, or skipped) — unknown,
 * not failed.
 */
export function lastRunOutcomeForTitle(
  outcomes: LatestRunOutcomes,
  title: string,
): { runId: string; passed: boolean; retried?: boolean } | undefined {
  const slug = `test-case-${slugify(title)}`
  if (outcomes.passed.has(slug)) {
    return {
      runId: outcomes.runId,
      passed: true,
      ...(outcomes.passedOnRetry.has(slug) ? { retried: true } : {}),
    }
  }
  if (outcomes.failed.has(slug)) return { runId: outcomes.runId, passed: false }
  return undefined
}
