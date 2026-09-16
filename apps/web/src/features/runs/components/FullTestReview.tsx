import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { TestFileReview } from '@shared/test-review'
import * as api from '@/shared/api/client'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { SourceComparisonTable, type ReviewSourceSelection } from '@/shared/ui/SourceComparisonTable'
import { TestLanguageSwitch } from '@/shared/ui/TestLanguageSwitch'
import { assessmentsForRows, comparedTestRows, englishLines, englishSourceRange, sourceRows, rowsForTest, type ContextRow } from '@/shared/lib/test-review-model'
import { noTestAssessmentCopy, testAssessmentFinding, testAssessmentReason } from '@/shared/lib/test-assessment-copy'
import type { VersionTest } from '@/shared/lib/test-versions'
import type { ReviewFocus } from '@/shared/lib/workspace-view-state'
export type { ReviewFocus } from '@/shared/lib/workspace-view-state'

interface EnglishReturnPoint {
  selection: ReviewSourceSelection
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
  const [mode, setMode] = useState<'english' | 'code'>(focus?.mode ?? 'english')
  const [cursor, setCursor] = useState<number | null>(null)
  const [selection, setSelection] = useState<ReviewSourceSelection | null>(null)
  const [englishReturn, setEnglishReturn] = useState<EnglishReturnPoint | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  // Keep the loaded file and highlighting mounted while changing tests, but
  // discard the previous test's English/code return position.
  useLayoutEffect(() => {
    setSelection(null)
    setEnglishReturn(null)
  }, [selectedTest?.line, selectedTest?.name, focus?.change])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api.getTestFileReview(feature, file, runId).then((result) => { if (!cancelled) { setData(result); setLoading(false) } })
      .catch((err: unknown) => { if (!cancelled) { setError(err instanceof Error ? err.message : 'Could not load test source'); setLoading(false) } })
    return () => { cancelled = true }
  }, [feature, file, runId, refresh, revision, retry])
  const rows = useMemo<ContextRow[]>(() => {
    if (!data) return []
    const side = focus?.change === 'removed' ? 'before' : 'after'
    if (selectedTest && focus?.change && data[side].tests.some((test) => test.line === selectedTest.line && test.name === selectedTest.name)) return comparedTestRows(data, selectedTest, focus.change)
    const context = sourceRows(data)
    return runId ? context.map(({ change: _change, ...row }) => row) : context
  }, [data, selectedTest, focus?.change, runId])
  const changes = [...new Set(rows.flatMap((row) => row.change == null ? [] : [row.change]))]
  const focusedChange = rows.find((row) => row.afterLine != null && row.afterLine >= (focus?.line ?? 0) && row.change != null)?.change
  const index = Math.min(cursor ?? Math.max(0, changes.indexOf(focusedChange ?? changes[0])), Math.max(0, changes.length - 1))
  const testSide = focus?.change === 'removed' ? 'before' : 'after'
  const sourceTest = selectedTest && (data?.[testSide].tests.find((test) => test.line === selectedTest.line && test.name === selectedTest.name)
    ?? data?.[testSide].tests.find((test) => test.name === selectedTest.name))
  const change = runId ? undefined : changes[index]
  const selectedRows = sourceTest && data ? rowsForTest(rows, { key: `${testSide}:${sourceTest.line}`, side: testSide, test: sourceTest }, data)
    : rows.filter((row) => change != null && row.change === change)
  const sourceLine = selectedRows.find((row) => row.afterLine != null)?.afterLine ?? focus?.line ?? 1
  useLayoutEffect(() => {
    const pane = scroll.current
    if (mode === 'english' && englishReturn && pane) {
      pane.scrollTop = englishReturn.top
      pane.scrollLeft = englishReturn.left
      pane.querySelector<HTMLButtonElement>(`[data-side="${englishReturn.selection.side}"][data-source-line="${englishReturn.selection.line}"] button`)?.focus({ preventScroll: true })
      return
    }
    const target = selection ?? (selectedTest ? sourceTest ? { side: testSide, line: sourceTest.line } : undefined
      : focus?.line != null ? { side: testSide, line: focus.line } : undefined)
    const targetLine = target && mode === 'english' && data ? englishSourceRange(englishLines(data[target.side]), target.line).line : target?.line
    const active = pane?.querySelector(target
      ? `[data-side="${target.side}"][data-source-line="${targetLine}"]` : '[data-selected="true"]')
    if (active instanceof HTMLElement) {
      active.scrollIntoView?.({ block: selectedTest && !selection ? 'start' : 'center', behavior: 'instant' })
      if (selectedTest && !selection && pane) pane.scrollTop -= pane.querySelector('thead')?.getBoundingClientRect().height ?? 0
      if (selection && mode === 'code') active.focus({ preventScroll: true })
    }
  }, [change, mode, loading, selection, englishReturn, data, focus?.line, testSide, selectedTest, sourceTest])
  const assessments = data ? assessmentsForRows(data, selectedRows) : []
  const updateFocus = (line: number | undefined, nextMode = mode): void => onFocus?.({ file, line: selectedTest?.line ?? line, mode: nextMode, ...(runId ? { baseline: 'run' } : {}), ...(focus?.change ? { change: focus.change, test: selectedTest?.name ?? focus.test } : {}) })
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
      const top = pane?.querySelector('thead')?.getBoundingClientRect().bottom ?? pane?.getBoundingClientRect().top ?? 0
      const visible = [...pane?.querySelectorAll<HTMLElement>('[data-source-line]:not([data-source-continuation])') ?? []]
        .find((element) => { const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.bottom > top })
      const side = visible?.dataset.side === 'before' ? 'before' : 'after'
      const line = visible ? Number(visible.dataset.sourceLine) : focus?.line ?? sourceLine
      const range = data ? englishSourceRange(englishLines(data[side]), line) : { line, endLine: line }
      setSelection({ side, ...range })
      updateFocus(range.line, nextMode)
    }
    setMode(nextMode)
  }
  const navigate = (next: number): void => {
    if (mode === 'english') setEnglishReturn(null)
    setSelection(null)
    setCursor(next)
    updateFocus(rows.find((row) => row.change === changes[next] && row.afterLine != null)?.afterLine)
  }
  return <>
    <div className="cl-context-toolbar">
      <TestLanguageSwitch mode={mode} onChange={changeMode} />
      {selectedTest && <><span className="text-xs text-secondary">{focus?.change === 'removed' ? 'Removed test' : focus?.change === 'added' ? 'Added test' : 'Changed test'}</span>
        <span className="min-w-0 truncate text-xs text-secondary" title={selectedTest.previous && selectedTest.previous.name !== selectedTest.name ? `${selectedTest.previous.name} → ${selectedTest.name}` : selectedTest.name} data-testid="review-selected-test">{selectedTest.name}</span></>}
      {baselineControl}
    </div>
    {!loading && !error && selectedTest && !sourceTest && <p role="status" className="px-3 py-2 text-xs text-warning">This test is in the {testSide === 'before' ? 'recorded' : 'current'} test list, but its matching declaration is unavailable in this source snapshot. Showing file context; no test is highlighted.</p>}
    {navigationTarget && createPortal(
      <div className="cl-review-change-nav" role="group" aria-label="Edit blocks in this file" title="Each block is a consecutive group of edited lines in this file. A block may contain imports, setup, or several tests. This is not the suite's changed-test count.">
        <button className="cl-icon-button" aria-label="Previous change" disabled={index === 0 || loading || !!error} onClick={() => navigate(index - 1)}>←</button>
        <span aria-live="polite">{loading ? 'Loading…' : error ? 'Unavailable' : changes.length ? `Edit ${index + 1} / ${changes.length}` : 'No edits'}</span>
        <button className="cl-icon-button" aria-label="Next change" disabled={index >= changes.length - 1 || loading || !!error} onClick={() => navigate(index + 1)}>→</button>
      </div>, navigationTarget)}
    {error ? <div role="alert" className="flex-1 p-4 text-sm">{error}<button className="cl-button ml-3 px-3 py-1" onClick={() => setRetry(retry + 1)}>Retry</button></div>
      : loading || !data ? <div role="status" className="flex-1 p-4 text-sm text-secondary">Loading complete test source…</div>
      : <div className="cl-context-table min-h-0 flex-1"><SourceComparisonTable review={data} rows={rows} mode={mode} change={change} scrollRef={scroll}
        emptySide={selectedTest && focus?.change === 'removed' ? 'after' : selectedTest && focus?.change === 'added' ? 'before' : undefined}
        returnSelection={englishReturn?.selection} onReturnToEnglish={() => changeMode('english')}
        selection={selection} onSelectSource={(next) => {
          // A source click only exists while the comparison pane is mounted.
          const pane = scroll.current!
          setEnglishReturn({ selection: next, top: pane.scrollTop, left: pane.scrollLeft, cursor: index })
          setCursor(index); setSelection(next); setMode('code'); updateFocus(next.line, 'code')
        }} /></div>}
    <div className="cl-context-assessment" aria-live="polite">
      {!loading && !error && data && <>
      {data.assessment.reasons?.map((reason) => <p key={reason} className="text-warning">{testAssessmentReason(reason)}</p>)}
      {data?.before.parseError || data?.after.parseError ? <p className="text-warning">The plain-English view is incomplete. Switch to Code to see the complete source.</p> : null}
      {selectedTest && focus?.change === 'removed' ? <p className="text-secondary">This test was removed from the current source.</p>
        : selectedTest && focus?.change === 'added' ? <p className="text-secondary">This test was added after the recorded version.</p>
        : runId && !selectedTest ? <p className="text-secondary">{comparisonReady ? 'No title or test-content changes in this file. Tag and formatting edits are excluded.' : 'Test change information is not available yet.'}</p>
        : assessments.length ? <div className="text-warning">{[...new Set(assessments.map(testAssessmentFinding))].map((finding) => <p key={finding}>{finding}</p>)}</div>
        : <p className="text-secondary">{noTestAssessmentCopy(changes.length, runId)}</p>}
      </>}
    </div>
  </>
}
