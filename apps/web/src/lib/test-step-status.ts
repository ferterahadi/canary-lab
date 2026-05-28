// Pure utilities to map a Playwright test (extracted from the AST) onto its
// final-state status from the e2e-summary.json. Per-step granularity is not
// available yet — every step within a test inherits the test's overall
// status. Once a per-step reporter lands we can refine `statusForStep` to take
// the step path and look it up individually.

import type { RunSummary } from '../api/types'

export type StepStatus = 'pending' | 'testing' | 'passed' | 'failed' | 'skipped' | 'timedout'
export type RunningTestSummary = NonNullable<RunSummary['running']>
export interface TestStatusIdentity {
  name: string
  id?: string
}

export interface StatusPresentation {
  label: string
  cardClassName: string
  pillClassName: string
}

export const STATUS_PRESENTATION: Record<StepStatus, StatusPresentation> = {
  passed: {
    label: 'passed',
    cardClassName: 'border-emerald-500/40 bg-emerald-500/5 dark:border-emerald-500/50',
    pillClassName: 'border-emerald-500/60 bg-emerald-50 text-emerald-700 dark:border-emerald-400/60 dark:bg-emerald-400/10 dark:text-emerald-300',
  },
  testing: {
    label: 'running',
    cardClassName: 'border-sky-500/50 bg-sky-500/10 dark:border-sky-500/60',
    pillClassName: 'border-sky-500/60 bg-sky-50 text-sky-700 dark:border-sky-400/60 dark:bg-sky-400/10 dark:text-sky-300',
  },
  failed: {
    label: 'failed',
    cardClassName: 'border-rose-500/50 bg-rose-500/5 dark:border-rose-500/60',
    pillClassName: 'border-rose-500/60 bg-rose-50 text-rose-700 dark:border-rose-400/60 dark:bg-rose-400/10 dark:text-rose-300',
  },
  skipped: {
    label: 'skipped',
    cardClassName: 'border-amber-500/40 bg-amber-500/5 dark:border-amber-500/50',
    pillClassName: 'border-amber-500/60 bg-amber-50 text-amber-700 dark:border-amber-400/60 dark:bg-amber-400/10 dark:text-amber-300',
  },
  timedout: {
    label: 'timeout',
    cardClassName: 'border-amber-500/40 bg-amber-500/5 dark:border-amber-500/50',
    pillClassName: 'border-amber-500/60 bg-amber-50 text-amber-700 dark:border-amber-400/60 dark:bg-amber-400/10 dark:text-amber-300',
  },
  pending: {
    label: 'pending',
    cardClassName: 'border-zinc-300 bg-zinc-50/40 dark:border-zinc-700 dark:bg-zinc-900/30',
    pillClassName: 'border-zinc-400/70 bg-transparent text-zinc-600 dark:border-zinc-500/70 dark:text-zinc-300',
  },
}

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
export function statusForTest(
  test: string | TestStatusIdentity,
  summary: RunSummary | undefined,
  isRunActivelyTesting = true,
): StepStatus {
  if (!summary) return 'pending'
  const identity = typeof test === 'string' ? { name: test } : test
  const expected = summaryEntryName(identity.name)
  // Currently-running wins over prior state. In targeted-rerun mode the
  // reporter seeds the new run from the prior summary, so the failed[]
  // entry for a test that is being re-run is still on disk while the test
  // is in flight. Checking `running` first lets the badge flip to "running"
  // instead of sticking on the stale "failed" label.
  if (isRunActivelyTesting && runningTestForIdentity(summary, expected, identity.id)) return 'testing'
  const failed = summary.failed.find((f) => matchesSummaryEntry(f, expected, identity.id))
  if (failed) {
    const msg = failed.error?.message ?? ''
    if (/Test timeout of/i.test(msg)) return 'timedout'
    return 'failed'
  }
  if (identity.id && summary.skippedIds?.includes(identity.id)) return 'skipped'
  if (summary.skippedNames?.includes(expected)) return 'skipped'
  if (identity.id && summary.passedIds) {
    return summary.passedIds.includes(identity.id) ? 'passed' : 'pending'
  }
  if (summary.passedNames) {
    return summary.passedNames.includes(expected) ? 'passed' : 'pending'
  }
  // Legacy fallback for summaries written before passedNames existed.
  if (summary.complete) return 'passed'
  return 'pending'
}

export function activeBodyLineForTest(input: {
  testName: string
  testLine: number
  bodySource: string
  summary: RunSummary | undefined
}): number | null {
  const expectedName = summaryEntryName(input.testName)
  const running = input.summary ? runningTestForSummaryName(input.summary, expectedName) : undefined
  const bodyLineCount = input.bodySource.split('\n').length
  if (running) {
    return bodyLineForLocations(
      running.step?.locations ?? (running.step?.location ? [running.step.location] : []),
      input.testLine,
      bodyLineCount,
    )
  }
  const failed = input.summary?.failed.find((entry) => entry.name === expectedName)
  if (!failed) return null
  return bodyLineForLocations(
    failed.locations?.length ? failed.locations : (failed.location ? [failed.location] : []),
    input.testLine,
    bodyLineCount,
  )
}

export function runningTestForSummaryName(
  summary: RunSummary,
  summaryName: string,
): RunningTestSummary | undefined {
  return summary.runningTests?.find((entry) => entry.name === summaryName)
    ?? (summary.running?.name === summaryName ? summary.running : undefined)
}

function runningTestForIdentity(
  summary: RunSummary,
  summaryName: string,
  id?: string,
): RunningTestSummary | undefined {
  if (id) {
    const byId = summary.runningTests?.find((entry) => entry.id === id)
      ?? (summary.running?.id === id ? summary.running : undefined)
    if (byId) return byId
  }
  return runningTestForSummaryName(summary, summaryName)
}

function matchesSummaryEntry(
  entry: { id?: string; name: string },
  summaryName: string,
  id?: string,
): boolean {
  if (id && entry.id) return entry.id === id
  return entry.name === summaryName
}

function bodyLineForLocations(locations: string[], testLine: number, bodyLineCount: number): number | null {
  for (const location of locations) {
    const absoluteLine = lineFromLocation(location)
    if (absoluteLine == null) continue
    const relativeLine = absoluteLine - testLine + 1
    if (relativeLine >= 1 && relativeLine <= bodyLineCount) return relativeLine
  }
  return null
}

function lineFromLocation(location: string): number | null {
  const match = location.match(/:(\d+)(?::\d+)?$/)
  if (!match) return null
  const line = Number(match[1])
  return Number.isFinite(line) ? line : null
}

export function colorClassForStatus(status: StepStatus): string {
  return STATUS_PRESENTATION[status].cardClassName
}

export function statusPillClassForStatus(status: StepStatus): string {
  return STATUS_PRESENTATION[status].pillClassName
}

export function statusLabel(status: StepStatus): string {
  return STATUS_PRESENTATION[status].label
}

export function statusFromPlaybackResult(input: { status?: string; passed?: boolean }): StepStatus {
  const normalized = input.status?.toLowerCase()
  if (normalized === 'passed' || input.passed === true) return 'passed'
  if (normalized === 'skipped') return 'skipped'
  if (normalized === 'timedout') return 'timedout'
  if (normalized === 'failed' || input.passed === false) return 'failed'
  return 'testing'
}
