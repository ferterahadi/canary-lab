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

// Map a Playwright test's final state from the summary. Returns 'pending'
// when the summary hasn't been written yet, the test isn't represented, or
// when `complete` is false and no failure entry exists for it (i.e. the test
// hasn't finished running).
export function statusForTest(testName: string, summary: RunSummary | undefined): StepStatus {
  if (!summary) return 'pending'
  const expected = summaryEntryName(testName)
  const failed = summary.failed.find((f) => f.name === expected)
  if (failed) {
    // Distinguish timed-out from generic failure when the error message
    // mentions a Playwright timeout (`Test timeout of …`). The summary
    // reporter doesn't separate them today, so this is heuristic. Skipped
    // tests don't appear in `failed` at all.
    const msg = failed.error?.message ?? ''
    if (/Test timeout of/i.test(msg)) return 'timedout'
    return 'failed'
  }
  // Not in failed[]. If the run is complete it must have passed (skipped
  // tests are not currently emitted by the reporter; reserve 'skipped' for
  // when that lands).
  if (summary.complete) return 'passed'
  return 'pending'
}

export function colorClassForStatus(status: StepStatus): string {
  switch (status) {
    case 'passed':
      return 'border-emerald-500/50 bg-emerald-500/5'
    case 'failed':
      return 'border-rose-500/60 bg-rose-500/5'
    case 'timedout':
    case 'skipped':
      return 'border-amber-500/50 bg-amber-500/5'
    case 'pending':
    default:
      return 'border-zinc-300 bg-zinc-100/30 dark:border-zinc-700 dark:bg-zinc-900/30'
  }
}
