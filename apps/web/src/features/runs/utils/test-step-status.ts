// Pure utilities to map a Playwright test (extracted from the AST) onto its
// status and latest reporter-owned step location from e2e-summary.json. The
// step location drives the live source highlight; verdict badges remain
// test-level because Playwright reports the final outcome at that level.

import type { RunSummary } from '@/shared/api/types'

export type StepStatus = 'pending' | 'testing' | 'passed' | 'failed' | 'skipped' | 'timedout'
export type TestExecutionHighlightKind = 'running' | 'failed'
export interface TestExecutionLineHighlight {
  kind: TestExecutionHighlightKind
  bodyLine: number
}
export type RunningTestSummary = NonNullable<RunSummary['running']>
export interface TestStatusIdentity {
  name: string
  id?: string
  /** False when a modern known-test inventory exists but this card could not
   *  be matched to one exact entry. In that case title-only matching is unsafe. */
  allowNameFallback?: boolean
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
  if (isRunActivelyTesting && runningTestForTest(summary, identity)) return 'testing'
  if (!identity.id && identity.allowNameFallback === false) return 'pending'
  const failed = summaryEntryForIdentity(summary.failed, expected, identity.id, identity.allowNameFallback)
  if (failed) {
    const msg = failed.error?.message ?? ''
    if (/Test timeout of/i.test(msg)) return 'timedout'
    return 'failed'
  }
  if (identity.id && summary.skippedIds?.includes(identity.id)) return 'skipped'
  if ((!identity.id || !summary.skippedIds) && summary.skippedNames?.includes(expected)) return 'skipped'
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

interface TestExecutionLineInput {
  testName: string
  testId?: string
  allowNameFallback?: boolean
  testLine: number
  /** First source line represented by bodySource. Defaults to testLine for
   *  summaries created before the extractor exposed bodyLine. */
  bodyLine?: number
  bodySource: string
  summary: RunSummary | undefined
  sourceFile?: string
}

export function executionLineHighlightForTest(
  input: TestExecutionLineInput & { isRunActivelyTesting: boolean },
): TestExecutionLineHighlight | null {
  const expectedName = summaryEntryName(input.testName)
  const running = input.isRunActivelyTesting && input.summary
    ? runningTestForTest(input.summary, {
        name: input.testName,
        id: input.testId,
        allowNameFallback: input.allowNameFallback,
      })
    : undefined
  const bodyLineCount = input.bodySource.split('\n').length
  const bodyStartLine = input.bodyLine ?? input.testLine
  if (running) {
    const bodyLine = bodyLineForLocations(
      running.step?.locations ?? (running.step?.location ? [running.step.location] : []),
      bodyStartLine,
      bodyLineCount,
      input.sourceFile,
    )
    return bodyLine == null ? null : { kind: 'running', bodyLine }
  }
  const failed = input.summary
    ? summaryEntryForIdentity(
        input.summary.failed,
        expectedName,
        input.testId,
        input.allowNameFallback,
      )
    : undefined
  if (!failed) return null
  const bodyLine = bodyLineForLocations(
    failed.locations?.length ? failed.locations : (failed.location ? [failed.location] : []),
    bodyStartLine,
    bodyLineCount,
    input.sourceFile,
  )
  return bodyLine == null ? null : { kind: 'failed', bodyLine }
}

export function activeBodyLineForTest(input: TestExecutionLineInput): number | null {
  return executionLineHighlightForTest({ ...input, isRunActivelyTesting: true })?.bodyLine ?? null
}

export function runningTestForTest(
  summary: RunSummary,
  test: TestStatusIdentity,
): RunningTestSummary | undefined {
  return summaryEntryForIdentity(
    runningEntries(summary),
    summaryEntryName(test.name),
    test.id,
    test.allowNameFallback,
  )
}

function runningEntries(summary: RunSummary): RunningTestSummary[] {
  return [
    ...(summary.runningTests ?? []),
    ...(summary.running ? [summary.running] : []),
  ]
}

function summaryEntryForIdentity<T extends { id?: string; name: string }>(
  entries: T[],
  summaryName: string,
  id?: string,
  allowNameFallback = true,
): T | undefined {
  const matchingNames = entries.filter((entry) => entry.name === summaryName)
  if (!id) return allowNameFallback ? matchingNames[0] : undefined
  const byId = matchingNames.find((entry) => entry.id === id)
  if (byId) return byId
  // Older summaries have no ids at all. Preserve their title fallback, but
  // never let one identified sibling stand in for another duplicate title.
  return matchingNames.some((entry) => entry.id) ? undefined : matchingNames[0]
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

export function sameSourceFile(a: string, b: string): boolean {
  const normalizedA = normalizedSourcePath(a)
  const normalizedB = normalizedSourcePath(b)
  if (normalizedA === normalizedB) return true

  // Playwright and the tests endpoint can refer to the same feature through
  // different checkout roots. Require a meaningful common suffix rather than
  // basename-only equality: two unrelated suites commonly both contain
  // `e2e/foo.spec.ts`, while `<feature>/e2e/foo.spec.ts` is stable across roots.
  const segmentsA = normalizedA.split('/').filter(Boolean)
  const segmentsB = normalizedB.split('/').filter(Boolean)
  let commonSuffix = 0
  while (
    commonSuffix < segmentsA.length &&
    commonSuffix < segmentsB.length &&
    segmentsA[segmentsA.length - 1 - commonSuffix] === segmentsB[segmentsB.length - 1 - commonSuffix]
  ) {
    commonSuffix += 1
  }
  return commonSuffix >= 3
}

function normalizedSourcePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^file:\/\//, '').replace(/\/{2,}/g, '/')
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
