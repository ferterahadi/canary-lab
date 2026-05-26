import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { ExtractedTest, FeatureSpecFile, RunStatus } from '../api/types'
import { activeBodyLineForTest, colorClassForStatus, runningTestForSummaryName, statusForTest, summaryEntryName, type StepStatus } from '../lib/test-step-status'
import type { RunSummary, RunSummaryRunningStep } from '../api/types'
import { ShikiCode, StatusPill, StepBlock } from './shared/TestCodeBlock'
import { ChevronRightIcon, StatusDot } from './config/atoms'

interface Props {
  feature: string | null
  activeRunSummary: RunSummary | undefined
  activeRunStatus: RunStatus | undefined
}

export function TestCasesColumn({ feature, activeRunSummary, activeRunStatus }: Props) {
  const [specs, setSpecs] = useState<FeatureSpecFile[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [expandedTest, setExpandedTest] = useState<string | null>(null)

  useEffect(() => {
    if (!feature) {
      setSpecs(null)
      setLoadError(null)
      return
    }
    let cancelled = false
    setSpecs(null)
    setLoadError(null)
    setExpandedTest(null)
    api.getFeatureTests(feature)
      .then((data) => {
        if (cancelled) return
        setSpecs(data)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(formatLoadError(err))
      })
    return () => { cancelled = true }
  }, [feature])

  if (!feature) {
    return (
      <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Select a feature
      </div>
    )
  }

  const runSpecs = activeRunSummary?.knownTests?.length
    ? specsFromRunSummary(activeRunSummary, specs)
    : null
  const displaySpecs = runSpecs ?? specs
  const totalTests = displaySpecs?.reduce((acc, s) => acc + s.tests.length, 0) ?? 0
  const isRunActivelyTesting = activeRunStatus === 'running'
  // Numerator is anchored to the *current* spec, not summary totals. Summary
  // entries can outlive the spec (e.g. seedFromExistingSummary preserves
  // ghosts from prior runs) which would otherwise push `done` past `total`.
  const passedCount = runSpecs && activeRunSummary
    ? activeRunSummary.passed
    : (displaySpecs ?? []).reduce(
        (acc, spec) => acc + spec.tests.filter(
          (t) => statusForTest({ name: t.name, id: t.id }, activeRunSummary, isRunActivelyTesting) === 'passed',
        ).length,
        0,
      )

  return (
    <div className="cl-panel flex h-full flex-col">
      <div className="cl-panel-header flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="cl-kicker">Tests</span>
          {totalTests > 0 && !activeRunSummary && <span className="cl-count-chip">{totalTests}</span>}
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
        {loadError && !runSpecs ? (
          <div className="rounded-md border px-3 py-2 text-xs" style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-default)', background: 'var(--bg-muted)' }}>
            {loadError}
          </div>
        ) : !displaySpecs ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading...</div>
        ) : displaySpecs.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No spec files found.</div>
        ) : (
          <div className="space-y-1.5">
            {displaySpecs.flatMap((spec) =>
              spec.tests.map((t) => {
                const key = `${spec.file}:${t.line}:${t.id ?? t.name}`
                const isExpanded = expandedTest === key
                const entryName = summaryEntryName(t.name)
                const runningTest = isRunActivelyTesting && activeRunSummary
                  ? runningTestForSummaryName(activeRunSummary, entryName)
                  : undefined
                const runningLocation = runningTest?.location
                const isRunningTest = Boolean(runningLocation)
                const activeLine = activeBodyLineForTest({
                  testName: t.name,
                  testLine: t.line,
                  bodySource: t.bodySource,
                  summary: isRunActivelyTesting ? activeRunSummary : undefined,
                })
                const activeSourceLine = activeLine == null ? null : t.line + activeLine - 1
                return (
                  <TestCard
                    key={key}
                    sourceFile={t.sourceFile ?? spec.file}
                    test={t}
                    status={statusForTest({ name: t.name, id: t.id }, activeRunSummary, isRunActivelyTesting)}
                    runningLocation={runningLocation}
                    isRunningTest={isRunningTest}
                    runningStep={runningTest?.step}
                    activeLine={activeLine}
                    activeSourceLine={activeSourceLine}
                    expanded={isExpanded}
                    onToggle={() => setExpandedTest(isExpanded ? null : key)}
                  />
                )
              }),
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function specsFromRunSummary(summary: RunSummary, specs: FeatureSpecFile[] | null): FeatureSpecFile[] {
  const byFile = new Map<string, ExtractedTest[]>()
  const sourceByLocation = testsByLocation(specs)
  const sourceByFile = testsByFile(specs)
  for (const known of summary.knownTests ?? []) {
    const parsed = parseSummaryLocation(known.location)
    const file = parsed?.file ?? 'Run summary'
    const tests = byFile.get(file) ?? []
    const source = findSourceTest({
      parsed,
      knownName: known.name,
      knownTitle: known.title,
      sourceByLocation,
      sourceByFile,
    })
    tests.push({
      id: known.id,
      name: known.title ?? known.name,
      line: source?.line ?? parsed?.line ?? 0,
      bodySource: source?.bodySource ?? '',
      steps: source?.steps ?? [],
      ...(source?.sourceFile ? { sourceFile: source.sourceFile } : parsed?.file ? { sourceFile: parsed.file } : {}),
    })
    byFile.set(file, tests)
  }
  return [...byFile.entries()].map(([file, tests]) => ({ file, tests }))
}

function findSourceTest(input: {
  parsed: { file: string; line: number } | null
  knownName: string
  knownTitle?: string
  sourceByLocation: Map<string, ExtractedTest[]>
  sourceByFile: Map<string, ExtractedTest[]>
}): ExtractedTest | undefined {
  if (!input.parsed) return undefined
  const matchesKnown = (candidate: ExtractedTest) => {
    return candidate.name === input.knownTitle
      || candidate.name === input.knownName
      || summaryEntryName(candidate.name) === input.knownName
  }

  const exactCandidates = input.sourceByLocation.get(locationKey(input.parsed.file, input.parsed.line))
  const exact = exactCandidates?.find(matchesKnown) ?? exactCandidates?.[0]
  if (exact) return exact

  const sameFileMatches = (input.sourceByFile.get(input.parsed.file) ?? []).filter(matchesKnown)
  return sameFileMatches.length === 1 ? sameFileMatches[0] : undefined
}

function testsByLocation(specs: FeatureSpecFile[] | null): Map<string, ExtractedTest[]> {
  const out = new Map<string, ExtractedTest[]>()
  for (const spec of specs ?? []) {
    for (const test of spec.tests) {
      const file = test.sourceFile ?? spec.file
      const key = locationKey(file, test.line)
      const tests = out.get(key) ?? []
      tests.push(test)
      out.set(key, tests)
    }
  }
  return out
}

function testsByFile(specs: FeatureSpecFile[] | null): Map<string, ExtractedTest[]> {
  const out = new Map<string, ExtractedTest[]>()
  for (const spec of specs ?? []) {
    for (const test of spec.tests) {
      const file = test.sourceFile ?? spec.file
      const tests = out.get(file) ?? []
      tests.push(test)
      out.set(file, tests)
    }
  }
  return out
}

function locationKey(file: string, line: number): string {
  return `${file}:${line}`
}

function parseSummaryLocation(location: string | undefined): { file: string; line: number } | null {
  if (!location) return null
  const match = /^(.*):(\d+)(?::\d+)?$/.exec(location)
  if (!match) return { file: location, line: 0 }
  return { file: match[1], line: Number(match[2]) }
}

function formatLoadError(err: unknown): string {
  if (err instanceof api.ApiError) {
    return `Unable to load tests for this feature. Server returned HTTP ${err.status}.`
  }
  return 'Unable to load tests for this feature.'
}

function TestCard({
  sourceFile,
  test,
  status,
  runningLocation,
  isRunningTest,
  runningStep,
  activeLine,
  activeSourceLine,
  expanded,
  onToggle,
}: {
  sourceFile: string
  test: ExtractedTest
  status: StepStatus
  runningLocation?: string
  isRunningTest: boolean
  runningStep?: RunSummaryRunningStep
  activeLine?: number | null
  activeSourceLine?: number | null
  expanded: boolean
  onToggle: () => void
}) {
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
        <div
          className="flex-1 min-w-0 truncate text-sm font-medium"
          title={test.name}
          style={{ color: 'var(--text-primary)' }}
        >
          {test.name}
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
        <StatusPill status={status} />
      </button>
      {expanded && (
        <div className="space-y-2 px-3 pb-3">
          {runningLocation && (
            <div
              className="rounded-md border px-2 py-1 text-[10px]"
              style={{
                color: 'var(--text-secondary)',
                borderColor: isRunningTest
                  ? 'rgb(234, 179, 8)'
                  : 'color-mix(in srgb, var(--accent) 40%, transparent)',
                background: isRunningTest ? 'rgba(234, 179, 8, 0.15)' : 'var(--accent-soft)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {runningStep?.location
                ? `Running line ${lineLabel(runningStep.location)} · ${runningStep.category}`
                : `Running from ${shortLocation(runningLocation)}`}
            </div>
          )}
          {test.steps.length > 0 ? (
            <ul className="space-y-1.5 pl-3" style={{ borderLeft: '1px solid var(--border-default)' }}>
              {test.steps.map((s, i) => (
                <StepBlock
                  key={`${s.line}:${i}`}
                  step={s}
                  status={status}
                  depth={0}
                  sourceFile={sourceFile}
                  runningSourceLine={isRunningTest ? activeSourceLine : null}
                />
              ))}
            </ul>
          ) : test.bodySource ? (
            <div
              style={
                isRunningTest && activeLine == null
                  ? {
                      borderRadius: 6,
                      padding: 2,
                      background: 'rgba(234, 179, 8, 0.12)',
                      boxShadow: 'inset 0 0 0 1px rgb(234, 179, 8), inset 3px 0 0 rgb(234, 179, 8)',
                    }
                  : undefined
              }
            >
              <ShikiCode
                source={test.bodySource}
                activeLine={activeLine}
                sourceLocation={{ file: sourceFile, startLine: test.line }}
                runningHighlight={isRunningTest}
              />
            </div>
          ) : (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              No test body available.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function lineLabel(location: string): string {
  const match = location.match(/:(\d+)(?::\d+)?$/)
  return match ? match[1] : shortLocation(location)
}

function shortLocation(location: string): string {
  const parts = location.split('/')
  return parts.slice(-2).join('/')
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
  return null
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
