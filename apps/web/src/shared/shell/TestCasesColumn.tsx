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

type DirtyDiff = { name: string; changedLines: number[] }[]
type TestCardExecutionHighlight = TestExecutionLineHighlight & { sourceLine: number }

interface ExpandedTestSelection {
  feature: string
  key: string | null
  autoExpandPending: boolean
}

interface Props {
  feature: string | null
  activeRunSummary: RunSummary | undefined
  activeRunManifest?: Pick<RunManifest, 'featureDir' | 'suiteSnapshot'>
  activeRunStatus: RunStatus | undefined
  onTotalTestsChange?: (n: number) => void
  /** Spec files flagged as modified, each with the test title(s) actually
   *  affected — only those test cards get the red "modified" treatment. */
  dirtySpecs?: DirtySpecSummary[]
}

export function TestCasesColumn({ feature, activeRunSummary, activeRunManifest, activeRunStatus, onTotalTestsChange, dirtySpecs = [] }: Props) {
  // The spec list refetches when a `tests-changed` event fires for the selected
  // feature (App gates the invalidation to the visible feature).
  const refreshKey = useInvalidationKey('tests')
  const [loaded, setLoaded] = useState<{ feature: string; specs: FeatureSpecFile[] } | null>(null)
  const specs = loaded?.feature === feature ? loaded.specs : null
  const previousLists = useRef(new Map<string, FeatureSpecFile[]>())
  const [discovery, setDiscovery] = useState<{ feature: string; specs: FeatureSpecFile[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [expandedTest, setExpandedTest] = useState<ExpandedTestSelection | null>(null)
  // Per-test changed-line numbers for each dirty spec file (diffed against git
  // HEAD server-side), keyed by that file's path. Fetched lazily, once per file.
  const [dirtyDiffs, setDirtyDiffs] = useState<Record<string, DirtyDiff>>({})

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
    setExpandedTest((current) => current?.feature === feature
      ? current
      : { feature, key: null, autoExpandPending: true })
    setLoadError(null)
    setDiscovery(null)
    setLoaded(previousLists.current.has(feature) ? { feature, specs: previousLists.current.get(feature)! } : null)
    setDirtyDiffs({})
    const failed = (message: string): void => {
      if (cancelled) return
      setLoadError(message)
      // A file-save event can arrive while the author is still writing the
      // suite. Retry briefly, keeping the last resolved list visible.
      if (attempts < 3) retryTimer = setTimeout(load, 1000)
    }
    const load = (): void => {
      attempts += 1
      api.getFeatureTests(feature)
        .then((data) => {
          if (cancelled) return
          const discoveryError = data.find((spec) => spec.discoveryError)?.discoveryError
          if (discoveryError) { setDiscovery({ feature, specs: data }); failed(discoveryError); return }
          const availableKeys = new Set(
            data.flatMap((spec) => spec.tests.map((test) => workspaceTestKey(spec.file, test))),
          )
          previousLists.current.set(feature, data)
          setDiscovery(null)
          setLoaded({ feature, specs: data })
          setLoadError(null)
          setExpandedTest((current) => {
            if (current?.feature !== feature || current.autoExpandPending) {
              return {
                feature,
                key: availableKeys.values().next().value ?? null,
                autoExpandPending: false,
              }
            }
            if (current.key !== null && !availableKeys.has(current.key)) {
              return { feature, key: null, autoExpandPending: false }
            }
            return current
          })
        })
        .catch((err) => failed(formatLoadError(err)))
    }
    load()
    return () => { cancelled = true; clearTimeout(retryTimer) }
  }, [feature, refreshKey, retryKey])

  useEffect(() => {
    if (!feature) return
    for (const spec of dirtySpecs) {
      if (spec.file in dirtyDiffs) continue
      api.getFeatureDirtyDiff(feature, spec.file)
        .then((res) => setDirtyDiffs((prev) => ({ ...prev, [spec.file]: res.tests })))
        .catch(() => setDirtyDiffs((prev) => ({ ...prev, [spec.file]: [] })))
    }
    // dirtyDiffs is read only to skip already-fetched files, not to react to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature, dirtySpecs])

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
  const diagnostics = incompleteSpecs.find((spec) => spec.discoveryDiagnostics)?.discoveryDiagnostics
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
          {activeRunManifest?.suiteSnapshot?.kind === 'taken' && (
            <span className="text-[10px] text-secondary" title="Statuses are from the selected run’s suite snapshot. The source below is the current workspace; edits made afterward have not been verified.">
              Last execution
            </span>
          )}
        </div>
        <TestsHeaderIndicator
          summary={activeRunSummary}
          totalTests={totalTests}
          passedCount={passedCount}
          specsLoaded={Boolean(specs)}
          isRunActivelyTesting={isRunActivelyTesting}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-3">
        {loadError && (
          <div role="status" className="mb-2 rounded-md border px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-default)', background: 'var(--bg-elevated)' }}>
            <div className="font-medium text-primary">Test discovery failed</div>
            <p className="mt-1">{loadError}</p>
            <p className="mt-1">{displaySpecs ? 'Showing the previous test list until discovery succeeds.' : 'A complete test list is unavailable. This is a discovery error, not a test result.'}</p>
            <p className="mt-1">Review the discovery error, fix the configuration or import it identifies, then retry.</p>
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
            <button type="button" className="cl-button mt-2 px-2 py-1" onClick={() => setRetryKey((key) => key + 1)}>Retry</button>
          </div>
        )}
        {!displaySpecs ? (
          !loadError && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading...</div>
        ) : displaySpecs.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No spec files found.</div>
        ) : (
          <div className="space-y-1.5">
            {displaySpecs.flatMap((spec) => {
              // Test-level dirty: only the test(s) named in the matching dirty
              // spec's `affectedTests` get the red treatment, not the whole file.
              const dirtySpec = dirtySpecs.find((d) => spec.file === d.file || spec.file.endsWith(`/${d.file}`))
              return spec.tests.map((t) => {
                const testDirty = dirtySpec?.affectedTests.includes(t.name) ?? false
                const diffLines = testDirty
                  ? dirtyDiffs[dirtySpec?.file ?? '']?.find((d) => d.name === t.name)?.changedLines
                  : undefined
                const changedLines = diffLines ? new Set(diffLines) : undefined
                // `t.id` used to be read here as a preferred key. The tests
                // endpoint builds each entry from name/line/bodySource/steps and
                // never sets an id, so the fallback was the only live arm — and
                // the mirror declared a field the server does not send.
                const sourceFile = t.sourceFile ?? spec.file
                const key = workspaceTestKey(spec.file, t)
                const isExpanded = expandedTest?.feature === feature && expandedTest.key === key
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
                    status={statusForTest(testIdentity, activeRunSummary, isRunActivelyTesting)}
                    isRunningTest={isRunningTest}
                    runningStep={runningTest?.step}
                    executionHighlight={executionHighlight}
                    expanded={isExpanded}
                    dirty={testDirty}
                    changedLines={changedLines}
                    onToggle={() => setExpandedTest({
                      feature,
                      key: isExpanded ? null : key,
                      autoExpandPending: false,
                    })}
                  />
                )
              })
            })}
          </div>
        )}
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
    return `Unable to load tests for this suite. Server returned HTTP ${err.status}.`
  }
  return 'Unable to load tests for this suite.'
}

function TestCard({
  sourceFile,
  testNumber,
  test,
  status,
  isRunningTest,
  runningStep,
  executionHighlight,
  expanded,
  dirty = false,
  changedLines,
  onToggle,
}: {
  sourceFile: string
  testNumber?: number
  test: ExtractedTest
  status: StepStatus
  isRunningTest: boolean
  runningStep?: RunSummaryRunningStep
  executionHighlight?: TestCardExecutionHighlight
  expanded: boolean
  dirty?: boolean
  /** Lines in `test.bodySource` that differ from the git HEAD version — see
   *  `changedLineNumbers`. Rendered as a danger-tinted diff highlight. */
  changedLines?: Set<number>
  onToggle: () => void
}) {
  const lineColor = executionHighlight?.kind === 'failed' ? 'var(--danger)' : 'var(--running)'
  const lineMessage = executionHighlight?.kind === 'failed'
    ? `Last failed line · line ${executionHighlight.sourceLine}`
    : executionHighlight
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
        // A modified spec rings the card in danger and tints it — overriding the
        // run-status colour, since "this test changed" outranks its last verdict.
        background: dirty
          ? 'color-mix(in srgb, var(--danger) 8%, transparent)'
          : expanded || isRunningTest ? 'var(--bg-selected)' : undefined,
        ...(dirty ? { boxShadow: 'inset 0 0 0 1px var(--danger)' } : {}),
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
          className="flex-1 min-w-0 truncate text-sm font-medium"
          title={test.name}
          style={{ color: 'var(--text-primary)' }}
        >
          {stripLeadingTestOrdinal(test.name)}
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
        <StepStatusBadge status={status} />
      </button>
      {expanded && (
        <div className="space-y-2 px-3 pb-3">
          {lineMessage && (
            <div
              className="rounded-md border px-2 py-1 text-[10px]"
              style={{
                color: 'var(--text-secondary)',
                borderColor: lineColor,
                background: `color-mix(in srgb, ${lineColor} 14%, transparent)`,
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
            <TestPresentation
              test={test}
              sourceFile={sourceFile}
              executionHighlight={executionHighlight}
              changedLines={changedLines}
            />
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
