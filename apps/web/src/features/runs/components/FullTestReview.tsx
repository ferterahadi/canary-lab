import { alignedSideLabels } from '@shared/test-view/render-model'
import { ReviewFlows, type ReviewInspection } from './ReviewFlows'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { reviewCaseKey, type TestFileReview, type VersionTest } from '@shared/test-review'
import * as featuresApi from '@/shared/api/features'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { TestLanguageSwitch } from '@/shared/ui/TestLanguageSwitch'
import { TestPresentation } from '@/shared/ui/TestPresentation'
import { assessmentsForRows, comparedTestRows } from '@/shared/lib/test-review-model'
import { englishLines, englishSourceRange } from '@shared/readable-tests/source-lines'
import { sourceRows, rowsForTest, type ContextRow } from '@shared/test-source-diff'
import type { TestViewSelection } from '@shared/test-view/render-model'
import { noTestAssessmentCopy, testAssessmentFinding, testAssessmentReason } from '@/shared/lib/test-assessment-copy'
import type { ReviewFocus } from '@/shared/lib/workspace-view-state'
import { displayError } from '@/shared/api/error-message'
interface EnglishReturnPoint {
  selection: TestViewSelection
  top: number
  left: number
  cursor: number
}

export function FullTestReview({ feature, file, runId, focus, onFocus, selectedTest, comparisonReady, revision, baselineControl, navigationTarget }: {
  feature: string; file: string; runId?: string; focus?: ReviewFocus
  selectedTest?: VersionTest
  comparisonReady?: boolean
  onFocus?: (focus: ReviewFocus) => void; revision?: string; baselineControl?: ReactNode; navigationTarget: HTMLDivElement | null
}) {
  const refresh = useInvalidationKey('tests')
  const [data, setData] = useState<TestFileReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'english' | 'code'>(focus?.comparisonMode ?? (focus?.mode === 'code' ? 'code' : 'english'))
  const [cursor, setCursor] = useState<number | null>(focus?.cursor ?? null)
  const [selection, setSelection] = useState<TestViewSelection | null>(null)
  const [englishReturn, setEnglishReturn] = useState<EnglishReturnPoint | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  // Keep the loaded file and highlighting mounted while changing tests, but
  // discard the previous test's English/code return position.
  useLayoutEffect(() => {
    setSelection(null)
    setEnglishReturn(null)
  }, [selectedTest?.line, selectedTest?.name, focus?.change])
  const loadedKey = useRef<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    const key = JSON.stringify([feature,file,runId])
    setLoading(loadedKey.current !== key)
    setError(null)
    featuresApi.getTestFileReview(feature, file, runId).then((result) => { if (!cancelled) { loadedKey.current=key; setData(result); setLoading(false) } })
      .catch((err: unknown) => { if (!cancelled) { setError(displayError(err, 'Could not load test source')); setLoading(false) } })
    return () => { cancelled = true }
  }, [feature, file, runId, refresh, revision, retry])
  const rows = useMemo<ContextRow[]>(() => {
    if (!data) return []
    const side = focus?.change === 'removed' ? 'before' : 'after'
    if (selectedTest && focus?.change && data[side].tests.some((test) => test.line === selectedTest.line && test.name === selectedTest.name)) return comparedTestRows(data, selectedTest, focus.change)
    const context = sourceRows(data)
    return runId && !data.supportingFile ? context.map(({ change: _change, ...row }) => row) : context
  }, [data, selectedTest, focus?.change, runId])
  const changes = [...new Set(rows.flatMap((row) => row.change == null ? [] : [row.change]))]
  const focusedChange = rows.find((row) => row.afterLine != null && row.afterLine >= (focus?.line ?? 0) && row.change != null)?.change
  const index = Math.min(focus?.cursor ?? cursor ?? Math.max(0, changes.indexOf(focusedChange ?? changes[0])), Math.max(0, changes.length - 1))
  const testSide = focus?.change === 'removed' ? 'before' : 'after'
  const sourceTest = selectedTest && (data?.[testSide].tests.find((test) => test.line === selectedTest.line && test.name === selectedTest.name)
    ?? data?.[testSide].tests.find((test) => test.name === selectedTest.name))
  const change = runId && !data?.supportingFile ? undefined : changes[index]
  const selectedRows = sourceTest && data ? rowsForTest(rows, { key: `${testSide}:${sourceTest.line}`, side: testSide, test: sourceTest }, data)
    : rows.filter((row) => change != null && row.change === change)
  const sourceLine = selectedRows.find((row) => row.afterLine != null)?.afterLine ?? focus?.line ?? 1
  useLayoutEffect(() => {
    const pane = scroll.current
    if (mode === 'english' && englishReturn && pane) {
      pane.scrollTop = englishReturn.top
      pane.scrollLeft = englishReturn.left
      const row = pane.querySelector<HTMLElement>(`[data-side="${englishReturn.selection.side}"][data-source-line="${englishReturn.selection.line}"]`)
      ;(row?.querySelector<HTMLElement>('button') ?? row)?.focus({ preventScroll: true })
      return
    }
    const target = selection ?? (selectedTest ? sourceTest ? { side: testSide, line: sourceTest.line } : undefined
      : focus?.line != null ? { side: testSide, line: focus.line } : undefined)
    const targetLine = target && mode === 'english' && data ? englishSourceRange(englishLines({ ...data[target.side], story: data[target.side].outline ?? data[target.side].story }), target.line).line : target?.line
    const active = pane?.querySelector(target
      ? `[data-side="${target.side}"][data-source-line="${targetLine}"]` : '[data-selected="true"]')
    if (active instanceof HTMLElement) {
      active.scrollIntoView?.({ block: selectedTest && !selection ? 'start' : 'center', behavior: 'instant' })
      if (selectedTest && !selection && pane) pane.scrollTop -= pane.querySelector('thead,.cl-comparison-reader-head')?.getBoundingClientRect().height ?? 0
      if (selection && mode === 'code') active.focus({ preventScroll: true })
    }
  }, [change, mode, loading, selection, englishReturn, data, focus?.line, testSide, selectedTest, sourceTest])
  const assessments = data ? assessmentsForRows(data, selectedRows) : []
  const updateFocus = (line: number | undefined, nextMode = mode, nextCursor?: number): void => onFocus?.({ file, ...(focus?.cursor !== undefined && nextCursor !== undefined && { cursor: nextCursor }), line: selectedTest?.line ?? line, mode: nextMode, ...(runId ? { baseline: 'run' } : {}), ...(focus?.change ? { change: focus.change, test: selectedTest?.name ?? focus.test } : {}) })
  const changeMode = (nextMode: 'english' | 'code'): void => {
    if (nextMode === mode) return
    if (nextMode === 'english' && englishReturn) {
      setSelection(englishReturn.selection)
      setCursor(englishReturn.cursor)
      updateFocus(englishReturn.selection.line, nextMode)
    } else {
      if (nextMode === 'code' && englishReturn && scroll.current) {
        setEnglishReturn({ ...englishReturn, top: scroll.current.scrollTop, left: scroll.current.scrollLeft, cursor: index })
      }
      // Compaction changes pixel positions. Anchor the toggle to the source at
      // the top of the viewport, including a code line inside an English range.
      const pane = scroll.current
      const top = pane?.querySelector('thead,.cl-comparison-reader-head')?.getBoundingClientRect().bottom ?? pane?.getBoundingClientRect().top ?? 0
      const visible = [...pane?.querySelectorAll<HTMLElement>('[data-source-line]:not([data-source-continuation])') ?? []]
        .find((element) => { const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.bottom > top })
      const side = visible?.dataset.side === 'before' ? 'before' : 'after'
      const line = visible ? Number(visible.dataset.sourceLine) : focus?.line ?? sourceLine
      const range = data ? englishSourceRange(englishLines({ ...data[side], story: data[side].outline ?? data[side].story }), line) : { line, endLine: line }
      setSelection({ side, ...range })
      updateFocus(range.line, nextMode)
    }
    setMode(nextMode)
  }
  const navigate = (next: number): void => {
    if (mode === 'english') setEnglishReturn(null)
    setSelection(null)
    setCursor(next)
    updateFocus(rows.find((row) => row.change === changes[next] && row.afterLine != null)?.afterLine, mode, next)
  }
  const graphOpen = !!focus?.flow && !focus.flow.combined
  const inspect = ({ side, flow }: ReviewInspection) => onFocus?.({
    ...focus, file, side, cursor: index, comparisonMode: mode, mode: flow.mode, flow,
  })
  const leaveGraph = () => onFocus?.({ ...focus, file, mode, comparisonMode: undefined, side: undefined, flow: undefined, cursor: index })
  const header = <>
    {selectedTest && <><span className="text-xs text-secondary">{focus?.change === 'removed' ? 'Removed test' : focus?.change === 'added' ? 'Added test' : 'Changed test'}</span>
      <span className="min-w-0 truncate text-xs text-secondary" title={selectedTest.previous && selectedTest.previous.name !== selectedTest.name ? `${selectedTest.previous.name} → ${selectedTest.name}` : selectedTest.name} data-testid="review-selected-test">{selectedTest.name}</span></>}
    {baselineControl}
  </>
  const ready = !loading && !error && data !== null
  return <>
    {!ready && <div className="cl-context-toolbar"><TestLanguageSwitch reader="compact" mode={mode === 'code' ? 'code' : 'visual'} onVisual={() => changeMode('english')} onChange={changeMode} />{header}</div>}
    {navigationTarget && createPortal(
      <div className="cl-review-change-nav" role="group" aria-label="Edit blocks in this file" title="Each block is a consecutive group of edited lines in this file. A block may contain imports, setup, or several tests. This is not the suite's changed-test count.">
        <button className="cl-icon-button" aria-label="Previous change" disabled={index === 0 || loading || !!error} onClick={() => navigate(index - 1)}>←</button>
        <span aria-live="polite">{loading ? 'Loading…' : error ? 'Unavailable' : changes.length ? `Edit ${index + 1} / ${changes.length}` : 'No edits'}</span>
        <button className="cl-icon-button" aria-label="Next change" disabled={index >= changes.length - 1 || loading || !!error} onClick={() => navigate(index + 1)}>→</button>
      </div>, navigationTarget)}
    {error ? <div role="alert" className="flex-1 p-4 text-sm">{error}<button className="cl-button ml-3 px-3 py-1" onClick={() => setRetry(retry + 1)}>Retry</button></div>
      : !ready ? <div role="status" className="flex-1 p-4 text-sm text-secondary">Loading complete test source…</div>
      : graphOpen && !focus?.flow?.expanded ? null
      : <TestPresentation view="aligned" inspection={focus?.flow?.combined ? {side:focus.side ?? testSide,flow:focus.flow} : undefined} onInspect={onFocus && inspect}
        scopedCase={sourceTest && { [testSide]: reviewCaseKey(sourceTest),
          ...data.declarationPairs?.find(pair => pair[testSide] === reviewCaseKey(sourceTest)) }} review={data} rows={rows} mode={mode} onModeChange={changeMode} header={header} change={change} scrollRef={scroll}
        anchor={sourceTest || focus?.line ? { side: testSide, line: sourceTest?.line ?? focus!.line! } : undefined}
        emptySide={selectedTest && focus?.change === 'removed' ? 'after' : selectedTest && focus?.change === 'added' ? 'before' : undefined}
        returnSelection={englishReturn?.selection} onReturnToEnglish={() => changeMode('english')}
        selection={selection} onSelectSource={(next) => {
          // A source click only exists while the comparison pane is mounted.
          const pane = scroll.current!
          setEnglishReturn({ selection: next, top: pane.scrollTop, left: pane.scrollLeft, cursor: index })
          setCursor(index); setSelection(next); setMode('code'); updateFocus(next.line, 'code')
        }}
        notice={selectedTest && !sourceTest && <p role="status" className="px-3 py-2 text-xs text-warning">This test is in the {testSide === 'before' ? 'recorded' : 'current'} test list, but its matching declaration is unavailable in this source snapshot. Showing file context; no test is highlighted.</p>} />}
    {ready && data && focus?.flow && !focus.flow.combined && <ReviewFlows sources={data} labels={alignedSideLabels(data)}
      inspection={{ side: focus.side ?? testSide, flow: focus.flow }} onInspect={inspect} onReturn={leaveGraph}
      selectedCase={selectedTest && { side: testSide, card: reviewCaseKey(selectedTest) }} toolbar={header} />}
    <div className="cl-context-assessment" aria-live="polite">
      {!loading && !error && data && <>
      {data.assessment.reasons?.map((reason) => <p key={reason} className="text-warning">{testAssessmentReason(reason)}</p>)}
      {data?.before.parseError || data?.after.parseError ? <p className="text-warning">The plain-English view is incomplete. Switch to Code to see the complete source.</p> : null}
      {data.supportingFile ? <p className="text-secondary">Supporting-file changes affect the suite executed by this run. They are included in approval, but are not counted as changed test declarations.</p>
        : selectedTest && focus?.change === 'removed' ? <p className="text-secondary">This test was removed from the current source.</p>
        : selectedTest && focus?.change === 'added' ? <p className="text-secondary">This test was added after the recorded version.</p>
        : runId && !selectedTest ? <p className="text-secondary">{comparisonReady ? 'No title or test-content changes in this file. Tag and formatting edits are excluded.' : 'Test change information is not available yet.'}</p>
        : assessments.length ? <div className="text-warning">{[...new Set(assessments.map(testAssessmentFinding))].map((finding) => <p key={finding}>{finding}</p>)}</div>
        : <p className="text-secondary">{noTestAssessmentCopy(changes.length, runId)}</p>}
      </>}
    </div>
  </>
}
