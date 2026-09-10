import { discoveryRepairActive } from '@shared/discovery-repair'
import { useDiscoveryRepair } from './use-discovery-repair'
import { DiscoveryRepairActivity } from './DiscoveryRepairActivity'
import { Section, CopyField } from '../ui/atoms'
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

type TestCardExecutionHighlight = TestExecutionLineHighlight & { sourceLine: number }

interface ExpandedTestSelection {
  sourceKey: string
  key: string | null
  autoExpandPending: boolean
}

interface Props {
  currentTests?: boolean
  onCurrentTestsChange?: (current: boolean) => void
  feature: string | null
  activeRunSummary: RunSummary | undefined
  activeRunManifest?: Pick<RunManifest, 'featureDir' | 'suiteSnapshot' | 'specEdits' | 'runId'>
  activeRunStatus: RunStatus | undefined
  onReviewTest?: (file: string, line?: number, baseline?: 'run') => void
  onTotalTestsChange?: (n: number) => void
  /** Spec files flagged as modified, each with the test title(s) actually
   *  affected — only those test cards get a direct review action. */
  dirtySpecs?: DirtySpecSummary[]
}

export function TestCasesColumn({ feature, activeRunSummary, activeRunManifest, activeRunStatus, onTotalTestsChange, onReviewTest, currentTests = false, onCurrentTestsChange, dirtySpecs = [] }: Props) {
  // The spec list refetches when a `tests-changed` event fires for the selected
  // feature (App gates the invalidation to the visible feature).
  const refreshKey = useInvalidationKey('tests')
  const runId = activeRunManifest?.runId
  const sourceKey = `${feature ?? ''}:${runId ?? 'workspace'}`
  const recordedRosterKey = runId ? JSON.stringify(activeRunSummary?.knownTests ?? []) : ''
  const repairState = useDiscoveryRepair(feature)
  const latestRepair = repairState.repairs[0]
  const activeRepair = runId ? undefined : repairState.repairs.find(discoveryRepairActive)
  const [showRepairHistory, setShowRepairHistory] = useState(false)
  const repairCompletion = latestRepair && !discoveryRepairActive(latestRepair) ? latestRepair.id + latestRepair.updatedAt : ''
  const [loaded, setLoaded] = useState<{ sourceKey: string; specs: FeatureSpecFile[] } | null>(null)
  const specs = loaded?.sourceKey === sourceKey ? loaded.specs : null
  const previousLists = useRef(new Map<string, FeatureSpecFile[]>())
  const [discovery, setDiscovery] = useState<{ feature: string; specs: FeatureSpecFile[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [manualRetryAfter, setManualRetryAfter] = useState('')
  useEffect(() => { if (repairCompletion) setRetryKey((key) => key + 1) }, [repairCompletion])
  const [promptCopied, setPromptCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
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
    setPromptCopied(false)
    setCopyError(null)
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
          setLoaded({ sourceKey, specs: data })
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
  }, [feature, sourceKey, runId, recordedRosterKey, refreshKey, retryKey])

  const dirtyRevision = JSON.stringify(dirtySpecs)

  const [runDifferences, setRunDifferences] = useState<string[]>([])
  const runFiles = JSON.stringify((specs ?? []).map((spec) => spec.file))
  useEffect(() => {
    let cancelled = false
    setRunDifferences([])
    if (feature && runId && activeRunManifest?.suiteSnapshot?.kind === 'taken') {
      const featureDir = activeRunManifest?.suiteSnapshot?.kind === 'taken' ? activeRunManifest.suiteSnapshot.dir : activeRunManifest?.featureDir
      const files = (JSON.parse(runFiles) as string[]).map((file) => featureDir && file.startsWith(`${featureDir}/`) ? file.slice(featureDir.length + 1) : file)
      for (const file of files) void api.getTestFileDifference(feature, file, runId).then((review) => {
        if (!cancelled && review.changed) setRunDifferences((previous) => [...previous, file])
      }).catch(() => { /* A missing snapshot is already disclosed in the run detail. */ })
    }
    return () => { cancelled = true }
  }, [feature, runId, runFiles, refreshKey, dirtyRevision, activeRunManifest?.featureDir])

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
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Select a suite
      </div>
    )
  }

  const displaySpecs = specs
  const incompleteSpecs = discovery?.feature === feature ? discovery.specs : []
  const repairFailure = !runId && latestRepair?.status === 'failed' && manualRetryAfter !== repairCompletion ? latestRepair.diagnostic : null
  const discoveryError = loadError || repairFailure
  const diagnostics = repairFailure || incompleteSpecs.find((spec) => spec.discoveryDiagnostics)?.discoveryDiagnostics
  const repairPrompt = incompleteSpecs.find((spec) => spec.discoveryRepairPrompt)?.discoveryRepairPrompt
  const copyRepairPrompt = async (): Promise<void> => {
    if (!repairPrompt) return
    try {
      await navigator.clipboard.writeText(repairPrompt)
      setPromptCopied(true)
      setCopyError(null)
    } catch {
      setCopyError('Could not copy. Open the repair prompt below and copy it manually.')
    }
  }
  const isRunActivelyTesting = activeRunStatus === 'running'
  const passedCount = (displaySpecs ?? []).reduce(
    (acc, spec) => acc + spec.tests.filter(
      (t) => statusForTest(
        summaryIdentityForWorkspaceTest(t.name, t.line, sourceFileInRun(t.sourceFile ?? spec.file, activeRunManifest), activeRunSummary),
        activeRunSummary,
        isRunActivelyTesting,
      ) === 'passed',
    ).length,
    0,
  )

  return (
    <div className="cl-panel flex h-full flex-col">
      <div className="cl-panel-header flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="cl-kicker">Tests</span>
          {currentTests && <span className="text-[10px] text-secondary">Current source</span>}
          {runId && (
            <span className="text-[10px] text-secondary" title="Tests and statuses are from the selected run. Source is shown only when it was saved with that run.">
              Selected run
            </span>
          )}
        </div>
        {(runId || currentTests) && onCurrentTestsChange && <button type="button" className="cl-button px-2 py-1 text-[11px]" onClick={() => onCurrentTestsChange(!currentTests)}>{currentTests ? 'View recorded results' : 'View current tests'}</button>}
        {dirtySpecs.length > 0 && onReviewTest && <button className="cl-button px-2 py-1 text-[11px]" onClick={() => onReviewTest(dirtySpecs[0].file)}>Review {dirtySpecs.length} {dirtySpecs.length === 1 ? 'file' : 'files'}</button>}
        {runDifferences.length > 0 && onReviewTest && <button className="cl-button px-2 py-1 text-[11px]" title="Current tests differ from the selected run’s snapshot. Saving in Git does not validate them." onClick={() => onReviewTest(runDifferences[0], undefined, 'run')}>Different from this run</button>}
        <TestsHeaderIndicator
          summary={activeRunSummary}
          totalTests={totalTests}
          passedCount={passedCount}
          specsLoaded={Boolean(specs)}
          isRunActivelyTesting={isRunActivelyTesting}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-3">
        {specs?.some((spec) => spec.recordedSourceUnavailable) && <p role="status" className="mb-3 text-xs text-secondary">Showing recorded tests and results. Historical source is unavailable for some tests in this run.</p>}
        {repairState.error && <p role="status" className="mb-2 text-xs text-warning">{repairState.error}</p>}
        {activeRepair ? <DiscoveryRepairActivity repair={activeRepair} /> : <>
        {latestRepair && <details className="mb-2 text-xs" open={showRepairHistory} onToggle={(event) => setShowRepairHistory(event.currentTarget.open)}>
          <summary className="cursor-pointer text-accent">Repair history</summary>
          {showRepairHistory && <DiscoveryRepairActivity repair={latestRepair} />}
        </details>}
        {discoveryError && (
          <div role="status" className="mb-2 rounded-md border px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-default)', background: 'var(--bg-elevated)' }}>
            <div className="font-medium text-primary">{runId ? 'Recorded tests unavailable' : 'Test discovery failed'}</div>
            <p className="mt-1">{discoveryError}</p>
            <p className="mt-1">{runId ? 'Open Playwright to inspect the recorded results. Current workspace tests cannot replace this run’s evidence.' : displaySpecs ? 'Showing the previous test list until discovery succeeds.' : 'A complete test list is unavailable. This is a discovery error, not a test result.'}</p>
            {!runId && <div className="mt-3"><Section title="Two ways to repair it" bodyClassName="divide-y divide-[var(--border-default)]">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-3"><div>In Canary Lab<p className="text-[11px] text-muted">Runs in this workspace.</p></div><button type="button" className="cl-button px-2 py-1" disabled={repairState.starting} onClick={() => { void repairState.start() }}>{repairState.starting ? 'Starting…' : latestRepair?.status === 'failed' ? 'Resume repair' : 'Repair in Canary Lab'}</button></div>
              <div className="flex flex-col gap-1 px-3 py-3"><div>In your agent <span className="text-[11px] text-muted">· Paste in Claude or Codex.</span></div><CopyField value={`/canary-lab-repair-discovery ${feature}`} label="discovery repair command" /></div>
            </Section></div>}
            <details className="mt-2"><summary className="cursor-pointer text-accent">Manual recovery</summary><div className="mt-2 flex flex-wrap gap-2">
              {repairPrompt && <button type="button" className="cl-button px-2 py-1" onClick={copyRepairPrompt}>{promptCopied ? 'Copied repair prompt' : 'Copy repair prompt'}</button>}
              <button type="button" className="cl-button px-2 py-1" onClick={() => { setManualRetryAfter(repairCompletion); setRetryKey((key) => key + 1) }}>{runId ? 'Reload recorded tests' : 'Retry discovery'}</button>
            </div>
            </details>
            {copyError && <p role="alert" className="mt-2 text-danger">{copyError}</p>}
            {repairPrompt && <details className="mt-2">
              <summary className="cursor-pointer text-accent">View repair prompt</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px]">{repairPrompt}</pre>
            </details>}
            {diagnostics && <details className="mt-2">
              <summary className="cursor-pointer text-accent">View discovery error</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px]">{diagnostics}</pre>
            </details>}
            {!displaySpecs && incompleteSpecs.length > 0 && <details className="mt-2">
              <summary className="cursor-pointer text-accent">Source definitions · incomplete</summary>
              <p className="mt-1">Generated cases may be missing. These definitions are not the discovered test count.</p>
              {incompleteSpecs.map((spec) => <div key={spec.file} className="mt-2">
                <div className="break-all text-muted">{spec.file}</div>
                <ul className="mt-1 space-y-1">{spec.tests.map((test, i) => <li key={`${test.line}:${i}`}>{test.name}</li>)}</ul>
                {spec.parseError && <p className="text-danger">{spec.parseError}</p>}
              </div>)}
            </details>}
          </div>
        )}
        {!displaySpecs ? (
          !loadError && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading...</div>
        ) : displaySpecs.length === 0 ? (
          <div role="status" className="text-xs text-secondary">{runId
            ? isRunActivelyTesting || activeRunStatus === 'queued' || activeRunStatus === 'healing'
              ? 'Waiting for this run to record its test list.'
              : 'This run has no recorded test list. Select another run or start a new run to record its tests. Any available execution evidence is in Playwright.'
            : 'No spec files found.'}</div>
        ) : (
          <div className="space-y-1.5">
            {displaySpecs.flatMap((spec) => {
              const dirtySpec = !runId ? dirtySpecs.find((item) => spec.file === item.file || spec.file.endsWith(`/${item.file}`)) : undefined
              return spec.tests.map((t) => {
                const diff = runId ? undefined : t.sourceChanges
                const modified = diff ? diff.count > 0 : dirtySpec?.affectedTests.includes(t.name) ?? false
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
                    showStatus={!currentTests}
                    isRunningTest={isRunningTest}
                    runningStep={runningTest?.step}
                    executionHighlight={executionHighlight}
                    expanded={isExpanded}
                    modified={modified}
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
      </div>
    </div>
  )
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
  return summary?.knownTests?.length
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

function TestCard({
  sourceFile,
  testNumber,
  test,
  sourceUnavailable,
  status,
  showStatus,
  isRunningTest,
  runningStep,
  executionHighlight,
  expanded,
  modified,
  changedLines,
  onToggle,
}: {
  sourceFile: string
  testNumber?: number
  test: ExtractedTest
  sourceUnavailable?: boolean
  status: StepStatus
  showStatus: boolean
  isRunningTest: boolean
  runningStep?: RunSummaryRunningStep
  executionHighlight?: TestCardExecutionHighlight
  expanded: boolean
  modified: boolean
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
            aria-label="Modified since the committed test"
            title="Modified since the committed test"
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
        {showStatus && <StepStatusBadge status={status} />}
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
  specsLoaded,
  isRunActivelyTesting,
}: {
  summary: RunSummary | undefined
  totalTests: number
  passedCount: number
  specsLoaded: boolean
  isRunActivelyTesting: boolean
}) {
  if (summary) return <RunningIndicator summary={summary} totalTests={totalTests} passedCount={passedCount} isRunActivelyTesting={isRunActivelyTesting} />
  if (!specsLoaded || totalTests <= 0) return null
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
  summary,
  totalTests,
  passedCount,
  isRunActivelyTesting,
}: {
  summary: RunSummary
  totalTests: number
  passedCount: number
  isRunActivelyTesting: boolean
}) {
  // Denominator should reflect the *static* test count parsed from the spec
  // files, not `summary.total` — Playwright's reporter emits a partial total
  // until the suite enumeration completes (especially when filtered/retried),
  // which would briefly read "1/1" while 14 tests are actually queued.
  const total = totalTests > 0 ? totalTests : summary.total
  const done = totalTests > 0 ? passedCount : summary.passed
  const isTestRunning = isRunActivelyTesting
  return (
    <div
      className="flex items-center gap-1.5"
      style={{ color: 'var(--text-secondary)', fontSize: 11.5, fontWeight: 500 }}
    >
      {isTestRunning && <StatusDot state="running" halo />}
      {isTestRunning && <span style={{ color: 'var(--text-muted)' }}>Running</span>}
      <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {done}<span style={{ color: 'var(--text-muted)' }}>/{total}</span>
      </span>
    </div>
  )
}
