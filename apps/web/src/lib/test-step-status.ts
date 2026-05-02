// Pure utilities to map a Playwright test (extracted from the AST) onto its
// final-state status from the e2e-summary.json. Per-step granularity is not
// available yet — every step within a test inherits the test's overall
// status. Once a per-step reporter lands we can refine `statusForStep` to take
// the step path and look it up individually.

import type { RunSummary } from '../api/types'

export type StepStatus = 'pending' | 'passed' | 'failed' | 'skipped' | 'timedout'

// Slugify the test name the same way the summary reporter does
// (shared/e2e-runner/summary-reporter.ts). The summary entry is then
// `test-case-${slug}`. Kept inline so the frontend doesn't pull in a
// server-side module.
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function summaryEntryName(testName: string): string {
  return `test-case-${slugify(testName)}`
}

// Map a Playwright test's status from the summary. A test is only marked as
// passed/failed/timedout when Playwright actually reported on it — tests that
// never ran (because the suite was paused / stopped / hit max-failures)
// stay pending. This requires the summary to expose `passedNames`; older
// summaries without that field fall back to the legacy "complete ⇒ passed"
// heuristic for back-compat.
export function statusForTest(testName: string, summary: RunSummary | undefined): StepStatus {
  if (!summary) return 'pending'
  const expected = summaryEntryName(testName)
  const failed = summary.failed.find((f) => f.name === expected)
  if (failed) {
    const msg = failed.error?.message ?? ''
    if (/Test timeout of/i.test(msg)) return 'timedout'
    return 'failed'
  }
  if (summary.passedNames) {
    return summary.passedNames.includes(expected) ? 'passed' : 'pending'
  }
  // Legacy fallback for summaries written before passedNames existed.
  if (summary.complete) return 'passed'
  return 'pending'
}

export function colorClassForStatus(status: StepStatus): string {
  switch (status) {
    case 'passed':
      return 'border-emerald-500/40 bg-emerald-500/5 dark:border-emerald-500/50'
    case 'failed':
      return 'border-rose-500/50 bg-rose-500/5 dark:border-rose-500/60'
    case 'timedout':
    case 'skipped':
      return 'border-amber-500/40 bg-amber-500/5 dark:border-amber-500/50'
    case 'pending':
    default:
      return 'border-zinc-300 bg-zinc-50/40 dark:border-zinc-700 dark:bg-zinc-900/30'
  }
}
