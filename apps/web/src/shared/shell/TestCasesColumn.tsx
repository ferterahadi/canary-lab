import { discoveryRepairActive } from '@shared/discovery-repair'
import { useDiscoveryRepair } from './use-discovery-repair'
import { DiscoveryRepairActivity } from './DiscoveryRepairActivity'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import { useInvalidationKey } from '../state/invalidation'
import type { DirtySpecSummary, ExtractedTest, FeatureSpecFile, RunStatus } from '../api/types'
import {
  colorClassForStatus,
  executionLineHighlightForTest,
  runningTestForTest,
  sameSourceFile,
  sourceLineForBodyLine,
  statusForTest,
  type StepStatus,
  type TestExecutionLineHighlight,
  type TestStatusIdentity,
  summaryEntryName,
} from '@/features/runs'
import type { RunManifest, RunSummary, RunSummaryRunningStep } from '../api/types'
import { StepStatusBadge } from '../ui/TestCodeBlock'
import { TestPresentation } from '../ui/TestPresentation'
import { TestIdBadge } from '../ui/TestIdBadge'
import { buildTestNumbering, stripLeadingTestOrdinal, testNumberKey } from '../test-numbering'
import { sourceFileInRun } from '@/features/runs'
import { ChevronRightIcon, StatusDot } from '@/shared/ui/atoms'
import { useTestVersions } from './use-test-versions'
import type { TestChangeKind } from '../lib/test-versions'
import { TestsVersionHeader } from './TestsVersionHeader'
import { SkeletonBar } from '@/shared/ui/Skeleton'
import { EmptyState } from '@/shared/ui/EmptyState'
import { TestListUnavailableCard } from './TestListUnavailableCard'

type TestCardExecutionHighlight = TestExecutionLineHighlight & { sourceLine: number }

interface ExpandedTestSelection {
  sourceKey: string
  key: string | null
  autoExpandPending: boolean
}

type TestRunEvidence = {
  manifest?: Pick<RunManifest, 'featureDir' | 'suiteSnapshot' | 'specEdits' | 'runId'>
  summary?: RunSummary
  status?: RunStatus
}

interface Props {
  currentTests?: boolean
  /** Present while a run is selected, including while its details are loading. */
  onCurrentTestsChange?: (current: boolean) => void
  feature: string | null
  /** Workspace discovery is expected to be incomplete while the authoring
   *  agent is still changing spec files. */
  isAuthoringTests?: boolean
  /** Verdicts appear on cards only while the recorded source is shown. */
  runEvidence?: TestRunEvidence
  /** The run used for source comparison, including while current tests are shown.
   *  It can be present before the displayed run's roster has loaded. */
  comparisonBaseline?: TestRunEvidence
  onReviewTest?: (file: string, line?: number, baseline?: 'run', change?: TestChangeKind, test?: string) => void
  onTotalTestsChange?: (n: number) => void
  /** Spec files flagged as modified, each with the test title(s) actually
   *  affected — only those test cards get a direct review action. */
  dirtySpecs?: DirtySpecSummary[]
}

export function TestCasesColumn({ feature, isAuthoringTests = false, runEvidence, comparisonBaseline, onTotalTestsChange, onReviewTest, currentTests = false, onCurrentTestsChange, dirtySpecs = [] }: Props) {
  const baselineRun = comparisonBaseline?.manifest
  const baselineRunSummary = comparisonBaseline?.summary
  const baselineRunStatus = comparisonBaseline?.status
  const activeRunManifest = currentTests ? undefined : runEvidence?.manifest
  const activeRunSummary = currentTests ? undefined : runEvidence?.summary
  const activeRunStatus = currentTests ? undefined : runEvidence?.status
  // The spec list refetches when a `tests-changed` event fires for the selected
  // feature (App gates the invalidation to the visible feature).
  const refreshKey = useInvalidationKey('tests')
  const runId = activeRunManifest?.runId
  const workspaceAuthoring = isAuthoringTests && !runId
  const sourceKey = `${feature ?? ''}:${runId ?? 'workspace'}`
  const recordedRosterKey = runId ? JSON.stringify(activeRunSummary?.knownTests ?? []) : ''
  const repairState = useDiscoveryRepair(feature)
  const latestRepair = repairState.repairs[0]
  const activeRepair = runId ? undefined : repairState.repairs.find(discoveryRepairActive)
  const repairCompletion = latestRepair && !discoveryRepairActive(latestRepair) ? latestRepair.id + latestRepair.updatedAt : ''
  const [loaded, setLoaded] = useState<{ sourceKey: string; specs: FeatureSpecFile[]; revision?: string } | null>(null)
  const specs = loaded?.sourceKey === sourceKey ? loaded.specs : null
  const previousLists = useRef(new Map<string, FeatureSpecFile[]>())
  const [discovery, setDiscovery] = useState<{ feature: string; specs: FeatureSpecFile[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [manualRetryAfter, setManualRetryAfter] = useState('')
  const loadRevision = `${refreshKey}:${retryKey}`
  useEffect(() => { if (repairCompletion) setRetryKey((key) => key + 1) }, [repairCompletion])
  const [expandedTest, setExpandedTest] = useState<ExpandedTestSelection | null>(null)

  useEffect(() => {
    if (!feature) {
      setLoaded(null)
      setLoadError(null)
      setExpandedTest(null)
      return
    }
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    setExpandedTest((current) => current?.sourceKey === sourceKey
      ? current
      : { sourceKey, key: null, autoExpandPending: true })
    setLoadError(null)
    setDiscovery(null)
    setLoaded(previousLists.current.has(sourceKey) ? { sourceKey, specs: previousLists.current.get(sourceKey)! } : null)
    const failed = (message: string): void => {
      if (cancelled) return
      setLoadError(message)
      // A file-save event can arrive while the author is still writing the
      // suite. Retry briefly, keeping the last resolved list visible.
      if (attempts < 3) retryTimer = setTimeout(load, 1000)
    }
    const load = (): void => {
      attempts += 1
      api.getFeatureTests(feature, undefined, runId)
        .then((data) => {
          if (cancelled) return
          const discoveryError = data.find((spec) => spec.discoveryError)?.discoveryError
          if (discoveryError) { setDiscovery({ feature, specs: data }); failed(discoveryError); return }
          const availableKeys = new Set(
            data.flatMap((spec) => spec.tests.map((test) => workspaceTestKey(spec.file, test))),
          )
          previousLists.current.set(sourceKey, data)
          setDiscovery(null)
          setLoaded({ sourceKey, specs: data, revision: loadRevision })
          setLoadError(null)
          setExpandedTest((current) => {
            if (current?.sourceKey !== sourceKey || current.autoExpandPending) {
              return {
                sourceKey,
                key: availableKeys.values().next().value ?? null,
                autoExpandPending: false,
              }
            }
            if (current.key !== null && !availableKeys.has(current.key)) {
              return { sourceKey, key: null, autoExpandPending: false }
            }
            return current
          })
        })
        .catch((err) => failed(formatLoadError(err)))
    }
    load()
    return () => { cancelled = true; clearTimeout(retryTimer) }
  }, [feature, sourceKey, runId, recordedRosterKey, refreshKey, retryKey, workspaceAuthoring])

  const dirtyRevision = JSON.stringify(dirtySpecs)

  const baselineRunId = baselineRun?.runId
  const snapshotDir = baselineRun?.suiteSnapshot?.kind === 'taken' ? baselineRun.suiteSnapshot.dir : undefined
  const baselineFeatureDir = baselineRun?.featureDir
  const versions = useTestVersions({
    feature, baseline: baselineRun, displayed: specs, recordedView: Boolean(runId),
    revision: `${loadRevision}:${workspaceAuthoring}:${dirtyRevision}:${JSON.stringify(baselineRunSummary?.knownTests ?? [])}`,
    ready: loaded?.revision === loadRevision && !loadError && !discovery && !workspaceAuthoring,
    displayFailed: Boolean(loadError || discovery),
  })
  const runDifferences = versions.comparison.differences

  const totalTests = specs?.reduce((acc, s) => acc + s.tests.length, 0) ?? 0
  useEffect(() => {
    onTotalTestsChange?.(totalTests)
  }, [totalTests, onTotalTestsChange])

  // Canonical per-test ids, shared with Playback + the Coverage Ledger.
  const testNumbering = useMemo(
    () => buildTestNumbering(
      (specs ?? []).flatMap((s) => s.tests.map((t) => ({ file: t.sourceFile ?? s.file, line: t.line }))),
    ),
    [specs],
  )

  if (!feature) {
    // Compact: the title is the whole message, and the control that resolves
    // it is the Suites column beside this one — a body here would be three
    // lines telling the user to look left.
    return <EmptyState compact reason="not-yet" title="No suite selected" testId="tests-no-suite" />
  }

  const displaySpecs = specs
  const incompleteSpecs = discovery?.feature === feature ? discovery.specs : []
  const repairFailure = !runId && latestRepair?.status === 'failed' && manualRetryAfter !== repairCompletion ? latestRepair.diagnostic : null
  const discoveryError = loadError || repairFailure
  // What the card shows as the failure itself: Playwright's own diagnostics
  // when it produced any, the failed request otherwise. Its first line is the
  // diagnosis on the card; the rest opens behind `Full error output`.
  const errorOutput = repairFailure || incompleteSpecs.find((spec) => spec.discoveryDiagnostics)?.discoveryDiagnostics || discoveryError || ''
  const retryDiscovery = (): void => { setManualRetryAfter(repairCompletion); setRetryKey((key) => key + 1) }
  const isRunActivelyTesting = activeRunStatus === 'running'
  // Header and cards share the same identity/status rules, including skipped
  // and never-run tests that must not become passes.
  const testStatuses = statusesForSpecs(displaySpecs, activeRunManifest, activeRunSummary, isRunActivelyTesting)
  const passedCount = testStatuses.filter((s) => s === 'passed').length
  const skippedCount = testStatuses.filter((s) => s === 'skipped').length

  const recordedSummary = baselineRunSummary ?? activeRunSummary
  const recordedStatus = baselineRunStatus ?? activeRunStatus
  const recordedSpecs = baselineRun ? versions.recorded : runId ? specs : null
  const recordedStatuses = statusesForSpecs(recordedSpecs, baselineRun ?? activeRunManifest, recordedSummary, recordedStatus === 'running')

  return (
    <div className="cl-panel flex h-full flex-col">
      <TestsVersionHeader
        currentTests={currentTests}
        onCurrentTestsChange={onCurrentTestsChange}
        currentTotal={versions.current?.reduce((n, spec) => n + spec.tests.length, 0)}
        recordedTotal={recordedSpecs?.reduce((n, spec) => n + spec.tests.length, 0)}
        passed={recordedSummary && recordedSpecs ? recordedStatuses.filter((status) => status === 'passed').length : undefined}
        failed={recordedStatuses.filter((status) => status === 'failed' || status === 'timedout').length}
        skipped={recordedStatuses.filter((status) => status === 'skipped').length}
        running={recordedStatus === 'running'}
        runId={baselineRunId}
        comparison={versions.comparison}
        onReviewTest={onReviewTest}
        fallback={<>
          {currentTests && <span className="shrink-0 text-[10px] text-secondary">Current source</span>}
          {runId && <span className="shrink-0 text-[10px] text-secondary">Recorded tests</span>}
          <TestsHeaderIndicator summary={activeRunSummary} totalTests={totalTests} passedCount={passedCount} skippedCount={skippedCount}
            specsLoaded={Boolean(specs) && !workspaceAuthoring} isRunActivelyTesting={isRunActivelyTesting} />
        </>}
      />
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-3" style={{ scrollbarGutter: 'stable' }}>
        {workspaceAuthoring ? (
          <div data-testid="tests-authoring-placeholder">
            <div role="status" className="mb-3 flex items-center gap-2 text-xs text-running">
              <span className="cl-pulse h-1.5 w-1.5 rounded-full bg-[var(--running)]" aria-hidden="true" />
              Writing tests…
            </div>
            <div className="space-y-1.5">
              {SKELETON_NAME_WIDTHS.map((width, i) => <TestCardSkeleton key={width} width={width} row={i} />)}
            </div>
          </div>
        ) : <>
        {activeRepair ? <DiscoveryRepairActivity repair={activeRepair} /> : <>
        {discoveryError && <>
          {runId
            ? <TestListUnavailableCard
                testId="tests-unavailable-card"
                title="Recorded tests unavailable"
                lead="This run’s test list couldn’t be read."
                error={errorOutput}
                retryLabel="Reload recorded tests"
                onRetry={retryDiscovery}
              />
            : <TestListUnavailableCard
                testId="tests-unavailable-card"
                title="Test discovery failed"
                lead="Playwright couldn’t list this suite’s tests."
                error={errorOutput}
                retryLabel="Retry discovery"
                onRetry={retryDiscovery}
                repair={{
                  starting: repairState.starting,
                  resume: latestRepair?.status === 'failed',
                  onStart: () => { void repairState.start() },
                  command: `/canary-lab-repair-discovery ${feature}`,
                  startError: repairState.startError,
                }}
              />}
          {/* Sits under the card, beside what it describes: the stale list this
              note is about, or the tab that still holds the run's results. */}
          {runId
            ? <p className="mb-3 text-[11px] text-muted">Recorded results are still in the Playwright tab. Current tests can’t stand in for this run’s evidence.</p>
            : displaySpecs && <p className="mb-3 text-[11px] text-muted">Showing the last list that loaded.</p>}
        </>}
        {!displaySpecs ? (
          // The list is arriving, so the placeholder is the list: the same cards
          // the fetch resolves into, rather than a one-line "Loading..." that
          // the first spec then shoves off the pane. See `TestCardSkeleton`.
          !loadError && <div data-testid="tests-loading-placeholder">
            <span role="status" className="sr-only">Loading test cases…</span>
            <div className="space-y-1.5">
              {SKELETON_NAME_WIDTHS.map((width, i) => <TestCardSkeleton key={width} width={width} row={i} />)}
            </div>
          </div>
        ) : displaySpecs.length === 0 ? (
          // Compact, because each title is the whole message and the control
          // that resolves it — the run picker, the header's version tabs, an
          // editor — is never in this pane.
          runId
            ? isRunActivelyTesting || activeRunStatus === 'queued' || activeRunStatus === 'healing'
              ? <EmptyState compact reason="not-yet" title="Listing tests…" testId="tests-run-listing" />
              : <EmptyState compact reason="not-captured" title="This run recorded no tests" testId="tests-run-none" />
            : <EmptyState compact reason="not-yet" title="No tests in this suite yet" testId="tests-none" />
        ) : (
          <div className="space-y-1.5">
            {displaySpecs.flatMap((spec) => {
              // With a run in play the mark means one thing from both sides:
              // this test is not what the run executed. Only a column with no
              // run at all falls back to the committed baseline, because then
              // there is no run to differ from.
              const dirtySpec = !baselineRunId ? dirtySpecs.find((item) => spec.file === item.file || spec.file.endsWith(`/${item.file}`)) : undefined
              const runDifference = runDifferences.find((difference) => [snapshotDir, baselineFeatureDir]
                .some((dir) => dir && spec.file === `${dir}/${difference.file}`) || spec.file === difference.file)
              return spec.tests.map((t) => {
                const diff = baselineRunId ? undefined : t.sourceChanges
                const modified = baselineRunId
                  ? runDifference?.affectedTests.includes(t.name) ?? false
                  : diff ? diff.count > 0 : dirtySpec?.affectedTests.includes(t.name) ?? false
                const changedLines = diff ? new Set(diff.changedLines.map((line) => line - (t.bodyLine ?? t.line) + 1)) : undefined
                // `t.id` used to be read here as a preferred key. The tests
                // endpoint builds each entry from name/line/bodySource/steps and
                // never sets an id, so the fallback was the only live arm — and
                // the mirror declared a field the server does not send.
                const sourceFile = t.sourceFile ?? spec.file
                const key = workspaceTestKey(spec.file, t)
                const isExpanded = expandedTest?.sourceKey === sourceKey && expandedTest.key === key
                const testIdentity = summaryIdentityForWorkspaceTest(
                  t.name,
                  t.line,
                  sourceFileInRun(sourceFile, activeRunManifest),
                  activeRunSummary,
                  Boolean(runId),
                )
                const runningTest = isRunActivelyTesting && activeRunSummary
                  ? runningTestForTest(activeRunSummary, testIdentity)
                  : undefined
                const isRunningTest = Boolean(runningTest)
                const bodyStartLine = t.bodyLine ?? t.line
                const executionLine = executionLineHighlightForTest({
                  testName: t.name,
                  testId: testIdentity.id,
                  allowNameFallback: testIdentity.allowNameFallback,
                  testLine: t.line,
                  bodyLine: bodyStartLine,
                  bodySource: t.bodySource,
                  summary: activeRunSummary,
                  sourceFile: sourceFileInRun(sourceFile, activeRunManifest),
                  isRunActivelyTesting,
                })
                const executionHighlight: TestCardExecutionHighlight | undefined = executionLine
                  ? {
                      ...executionLine,
                      sourceLine: sourceLineForBodyLine(bodyStartLine, executionLine.bodyLine),
                    }
                  : undefined
                return (
                  <TestCard
                    key={key}
                    sourceFile={sourceFile}
                    testNumber={testNumbering.get(testNumberKey(sourceFile, t.line))}
                    test={t}
                    sourceUnavailable={spec.recordedSourceUnavailable}
                    status={statusForTest(testIdentity, activeRunSummary, isRunActivelyTesting)}
                    showStatus={!currentTests && Boolean(runId || activeRunSummary)}
                    showNotRun={Boolean(runId) && !isRunActivelyTesting}
                    isRunningTest={isRunningTest}
                    runningStep={runningTest?.step}
                    executionHighlight={executionHighlight}
                    expanded={isExpanded}
                    modified={modified}
                    modifiedLabel={baselineRunId ? 'Changed since this run' : 'Modified since the committed test'}
                    changedLines={changedLines}
                    onToggle={() => setExpandedTest({
                      sourceKey,
                      key: isExpanded ? null : key,
                      autoExpandPending: false,
                    })}
                  />
                )
              })
            })}
          </div>
        )}
        </>}
        </>}
      </div>
    </div>
  )
}

function statusesForSpecs(specs: FeatureSpecFile[] | null, manifest: TestRunEvidence['manifest'], summary: RunSummary | undefined, running: boolean): StepStatus[] {
  return (specs ?? []).flatMap((spec) => spec.tests.map((test) => statusForTest(
    summaryIdentityForWorkspaceTest(test.name, test.line, sourceFileInRun(test.sourceFile ?? spec.file, manifest), summary, Boolean(manifest?.runId)),
    summary, running,
  )))
}

function workspaceTestKey(specFile: string, test: ExtractedTest): string {
  return `${test.sourceFile ?? specFile}:${test.line}:${test.name}`
}

function parseSummaryLocation(location: string | undefined): { file: string; line: number } | null {
  if (!location) return null
  const match = /^(.*):(\d+)(?::\d+)?$/.exec(location)
  if (!match) return { file: location, line: 0 }
  return { file: match[1], line: Number(match[2]) }
}

function summaryIdentityForWorkspaceTest(
  name: string,
  line: number,
  file: string,
  summary: RunSummary | undefined,
  recorded = false,
): TestStatusIdentity {
  const matchesName = (known: NonNullable<RunSummary['knownTests']>[number]) => {
    return known.title === name || known.name === summaryEntryName(name)
  }
  // The recorded line is a hint, not an identity: a heal edit moves a test to
  // another line between cycles, and a targeted rerun only re-lists the tests it
  // re-runs — so a test that already passed can sit ten lines below where the
  // roster last saw it. The line decides only when one file declares the same
  // title more than once.
  const sameTest = (summary?.knownTests ?? []).filter((entry) => {
    const parsed = parseSummaryLocation(entry.location)
    return Boolean(parsed && sameSourceFile(parsed.file, file) && matchesName(entry))
  })
  const known = sameTest.length === 1
    ? sameTest[0]
    : sameTest.find((entry) => parseSummaryLocation(entry.location)?.line === line)
  if (known?.id) return { name, id: known.id }
  const hasExplicitLegacyResult = summary?.passedNames !== undefined
    || summary?.skippedNames?.includes(summaryEntryName(name))
    || summary?.failed.some((entry) => entry.name === summaryEntryName(name))
  return summary?.knownTests?.length || (recorded && !hasExplicitLegacyResult)
    ? { name, allowNameFallback: false }
    : { name }
}

function formatLoadError(err: unknown): string {
  if (err instanceof api.ApiError) {
    const context = `Unable to load tests for this suite. Server returned HTTP ${err.status}.`
    if (err.body && typeof err.body === 'object') {
      const body = err.body as { message?: unknown; error?: unknown }
      const message = typeof body.message === 'string' ? body.message : body.error
      if (typeof message === 'string') return `${context} ${message}`
    }
    return context
  }
  return 'Unable to load tests for this suite.'
}

/** The placeholder is the card it becomes — R83's rule from the flight stage
 *  panes applied to this column, for both of the column's waiting states: an
 *  authoring agent writing specs, and the plain fetch of a list that exists.
 *  A pane there keeps its settled card stack in every state, with only the
 *  figures replaced by bars, so a value lands in the slot its placeholder held. This column's settled stack is TestCards, so
 *  the placeholder is a TestCard: the same `cl-card` chrome, the same `space-y`
 *  rhythm, and the same 40px header row (`py-2.5` twice over a 20px line box),
 *  with the caret, `#N`, name, `:line` and status pill each standing in at their
 *  real footprint. A generic bar stack was a different shape to the list it
 *  became, so the pane re-laid itself out the moment the first spec landed.
 *
 *  Every bar carries the CARD's sweep offset rather than its own: one card is
 *  one test arriving, so it sweeps as a unit while the stack reads top-down. */
function TestCardSkeleton({ width, row }: { width: string; row: number }) {
  return (
    <div className="cl-card" data-testid="test-card-skeleton" aria-hidden="true">
      <div className="flex h-10 items-center gap-3 px-3">
        {/* Caret, then the `#N` badge at its `min-width`/height. */}
        <SkeletonBar awaiting="live" row={row} className="shrink-0" width="0.625rem" height={10} />
        <SkeletonBar awaiting="live" row={row} className="shrink-0" width="1.375rem" height={12} />
        <div className="min-w-0 flex-1">
          <SkeletonBar awaiting="live" row={row} width={width} height={11} />
        </div>
        {/* `:line`, then the status pill at its own `min-width: 3.5rem`. */}
        <SkeletonBar awaiting="live" row={row} className="shrink-0" width="1.75rem" height={9} />
        <SkeletonBar awaiting="live" row={row} className="shrink-0" width="3.5rem" height={14} />
      </div>
    </div>
  )
}

/** Per-card name widths. Fixed rather than randomized: `Math.random` would
 *  reshuffle the stack on every render, which reads as activity that is not
 *  happening. The count of entries IS the number of placeholder cards. */
const SKELETON_NAME_WIDTHS = ['58%', '41%', '69%'] as const

function TestCard({
  sourceFile,
  testNumber,
  test,
  sourceUnavailable,
  status,
  showStatus,
  showNotRun,
  isRunningTest,
  runningStep,
  executionHighlight,
  expanded,
  modified,
  modifiedLabel,
  changedLines,
  onToggle,
}: {
  sourceFile: string
  testNumber?: number
  test: ExtractedTest
  sourceUnavailable?: boolean
  status: StepStatus
  showStatus: boolean
  showNotRun: boolean
  isRunningTest: boolean
  runningStep?: RunSummaryRunningStep
  executionHighlight?: TestCardExecutionHighlight
  expanded: boolean
  modified: boolean
  modifiedLabel: string
  /** Lines in `test.bodySource` that differ from the git HEAD version — see
   *  `changedLineNumbers`. Rendered as changed source, independently of execution status. */
  changedLines?: Set<number>
  onToggle: () => void
}) {
  const lineMessage = executionHighlight?.kind === 'running'
    ? `Running now · line ${executionHighlight.sourceLine}${runningStep?.category ? ` · ${runningStep.category}` : ''}`
    : isRunningTest
      ? runningStep?.category
        ? `Running now · ${runningStep.category} · source line unavailable`
        : 'Running test · source line unavailable'
      : undefined
  return (
    <div
      className={`cl-card cl-card-hover transition-all duration-150 ${colorClassForStatus(status)}`}
      style={{
        background: expanded || isRunningTest ? 'var(--bg-selected)' : undefined,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 items-center justify-center transition-transform duration-150"
          style={{ color: 'var(--text-muted)', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <ChevronRightIcon />
        </span>
        <TestIdBadge n={testNumber} />
        <div
          className="flex flex-1 min-w-0 items-center gap-2 text-sm font-medium"
          title={test.name}
          style={{ color: 'var(--text-primary)' }}
        >
          {modified && <span
            role="img"
            aria-label={modifiedLabel}
            title={modifiedLabel}
            data-testid="test-modified-dot"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
          />}
          <span className="truncate">{stripLeadingTestOrdinal(test.name)}</span>
        </div>
        <span
          className="shrink-0"
          style={{
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
          }}
        >
          :{test.line}
        </span>
        {showStatus && <StepStatusBadge status={status} label={showNotRun && (status === 'unmatched' || status === 'pending') ? 'not run' : undefined} />}
      </button>
      {expanded && (
        <div className="space-y-2 px-3 pb-3">
          {lineMessage && (
            <div
              className="rounded-md border px-2 py-1 text-[10px]"
              style={{
                color: 'var(--text-secondary)',
                borderColor: 'var(--running)',
                background: 'color-mix(in srgb, var(--running) 14%, transparent)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {lineMessage}
            </div>
          )}
          <div
            style={
              isRunningTest && executionHighlight == null
                ? {
                    borderRadius: 6,
                    padding: 2,
                    background: 'color-mix(in srgb, var(--running) 12%, transparent)',
                    boxShadow: 'inset 0 0 0 1px var(--running), inset 3px 0 0 var(--running)',
                  }
                : undefined
            }
          >
            {sourceUnavailable ? <p className="text-xs text-secondary">Source was not retained for this test. Its status comes from the recorded run.</p> : <TestPresentation
              test={test}
              sourceFile={sourceFile}
              executionHighlight={executionHighlight}
              changedLines={changedLines}
            />}
          </div>
        </div>
      )}
    </div>
  )
}

function TestsHeaderIndicator({
  summary,
  totalTests,
  passedCount,
  skippedCount,
  specsLoaded,
  isRunActivelyTesting,
}: {
  summary: RunSummary | undefined
  totalTests: number
  passedCount: number
  skippedCount: number
  specsLoaded: boolean
  isRunActivelyTesting: boolean
}) {
  if (!specsLoaded || totalTests <= 0) return null
  if (summary) return <RunningIndicator totalTests={totalTests} passedCount={passedCount} skippedCount={skippedCount} isRunActivelyTesting={isRunActivelyTesting} />
  if (isRunActivelyTesting) {
    return (
      <div
        className="flex items-center gap-1.5"
        style={{ color: 'var(--text-secondary)', fontSize: 11.5, fontWeight: 500 }}
      >
        <StatusDot state="running" halo />
        <span>Running</span>
        <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>0/{totalTests}</span>
      </div>
    )
  }
  return <span className="cl-count-chip">{totalTests}</span>
}

function RunningIndicator({
  totalTests,
  passedCount,
  skippedCount,
  isRunActivelyTesting,
}: {
  totalTests: number
  passedCount: number
  skippedCount: number
  isRunActivelyTesting: boolean
}) {
  const isTestRunning = isRunActivelyTesting
  return (
    <div
      className="flex items-center gap-1.5"
      style={{ color: 'var(--text-secondary)', fontSize: 11.5, fontWeight: 500 }}
    >
      {isTestRunning && <StatusDot state="running" halo />}
      {isTestRunning && <span style={{ color: 'var(--text-muted)' }}>Running</span>}
      <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {passedCount}<span style={{ color: 'var(--text-muted)' }}>/{totalTests}</span>
      </span>
      {skippedCount > 0 && (
        <span
          style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
          title="Tests explicitly reported as skipped. They remain part of the suite."
        >
          · {skippedCount} skipped
        </span>
      )}
    </div>
  )
}
