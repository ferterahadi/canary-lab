// Pure utilities to map a Playwright test (extracted from the AST) onto its
// final-state status from the e2e-summary.json. Per-step granularity is not
// available yet — every step within a test inherits the test's overall
// status. Once a per-step reporter lands we can refine `statusForStep` to take
// the step path and look it up individually.

import type { RunSummary } from '../../../shared/api/types'

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
    cardClassName: 'border-success/40 bg-success/5 dark:border-success/50',
    pillClassName: 'border-success/60 bg-success/10 text-success',
  },
  testing: {
    label: 'running',
    cardClassName: 'border-running/50 bg-running/10 dark:border-running/60',
    pillClassName: 'border-running/60 bg-running/10 text-running',
  },
  failed: {
    label: 'failed',
    cardClassName: 'border-danger/50 bg-danger/5 dark:border-danger/60',
    pillClassName: 'border-danger/60 bg-danger/10 text-danger',
  },
  skipped: {
    label: 'skipped',
    cardClassName: 'border-warning/40 bg-warning/5 dark:border-warning/50',
    pillClassName: 'border-warning/60 bg-warning/10 text-warning',
  },
  timedout: {
    label: 'timeout',
    cardClassName: 'border-warning/40 bg-warning/5 dark:border-warning/50',
    pillClassName: 'border-warning/60 bg-warning/10 text-warning',
  },
  pending: {
    label: 'pending',
    cardClassName: 'border-line-strong bg-elevated/40',
    pillClassName: 'border-idle/70 bg-transparent text-secondary',
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
  sourceFile?: string
}): number | null {
  const expectedName = summaryEntryName(input.testName)
  const running = input.summary ? runningTestForSummaryName(input.summary, expectedName) : undefined
  const bodyLineCount = input.bodySource.split('\n').length
  if (running) {
    return bodyLineForLocations(
      running.step?.locations ?? (running.step?.location ? [running.step.location] : []),
      input.testLine,
      bodyLineCount,
      input.sourceFile,
    )
  }
  const failed = input.summary?.failed.find((entry) => entry.name === expectedName)
  if (!failed) return null
  return bodyLineForLocations(
    failed.locations?.length ? failed.locations : (failed.location ? [failed.location] : []),
    input.testLine,
    bodyLineCount,
    input.sourceFile,
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

function bodyLineForLocations(
  locations: string[],
  testLine: number,
  bodyLineCount: number,
  sourceFile?: string,
): number | null {
  const relativeBodyLine = (location: string): number | null => {
    const absoluteLine = lineFromLocation(location)
    if (absoluteLine == null) return null
    const relativeLine = absoluteLine - testLine + 1
    return relativeLine >= 1 && relativeLine <= bodyLineCount ? relativeLine : null
  }
  // When we know which file the card is showing, only ever highlight a line
  // from that file. Steps that run inside helper modules report their own
  // file (Playwright attributes each step to the first user frame, which for
  // a helper-wrapped call is the helper, not the spec). Highlighting those
  // would point at a line that isn't the code on screen, so we skip them and
  // keep the highlight on the deepest in-body call site instead.
  if (sourceFile) {
    for (const location of locations) {
      const file = fileFromLocation(location)
      if (file && sameSourceFile(file, sourceFile)) {
        const relative = relativeBodyLine(location)
        if (relative != null) return relative
      }
    }
    return null
  }
  for (const location of locations) {
    const relative = relativeBodyLine(location)
    if (relative != null) return relative
  }
  return null
}

function lineFromLocation(location: string): number | null {
  const match = location.match(/:(\d+)(?::\d+)?$/)
  if (!match) return null
  const line = Number(match[1])
  return Number.isFinite(line) ? line : null
}

function fileFromLocation(location: string): string | null {
  const match = location.match(/:(\d+)(?::\d+)?$/)
  if (!match || match.index == null) return null
  const file = location.slice(0, match.index)
  return file.length > 0 ? file : null
}

function sameSourceFile(a: string, b: string): boolean {
  if (a === b) return true
  const basenameA = a.slice(a.lastIndexOf('/') + 1)
  const basenameB = b.slice(b.lastIndexOf('/') + 1)
  return basenameA.length > 0 && basenameA === basenameB
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
