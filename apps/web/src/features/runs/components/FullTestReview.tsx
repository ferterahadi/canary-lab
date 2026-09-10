import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TestFileReview } from '@shared/test-review'
import * as api from '@/shared/api/client'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { SourceComparisonTable, type ReviewSourceSelection } from '@/shared/ui/SourceComparisonTable'
import { TestLanguageSwitch } from '@/shared/ui/TestLanguageSwitch'
import { assessmentsForRows, sourceRows } from '@/shared/lib/test-review-model'
import type { ReviewFocus } from '@/shared/lib/workspace-view-state'
export type { ReviewFocus } from '@/shared/lib/workspace-view-state'

interface EnglishReturnPoint {
  selection: ReviewSourceSelection
  top: number
  left: number
  cursor: number
}

export function FullTestReview({ feature, file, runId, focus, onFocus, revision, baselineControl }: {
  feature: string; file: string; runId?: string; focus?: ReviewFocus
  onFocus?: (focus: ReviewFocus) => void; revision?: string; baselineControl?: ReactNode
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
  const [editorError, setEditorError] = useState<string | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api.getTestFileReview(feature, file, runId).then((result) => { if (!cancelled) { setData(result); setLoading(false) } })
      .catch((err: unknown) => { if (!cancelled) { setError(err instanceof Error ? err.message : 'Could not load test source'); setLoading(false) } })
    return () => { cancelled = true }
  }, [feature, file, runId, refresh, revision, retry])
  const rows = useMemo(() => data ? sourceRows(data) : [], [data])
  const changes = [...new Set(rows.flatMap((row) => row.change == null ? [] : [row.change]))]
  const focusedChange = rows.find((row) => row.afterLine != null && row.afterLine >= (focus?.line ?? 0) && row.change != null)?.change
  const index = Math.min(cursor ?? Math.max(0, changes.indexOf(focusedChange ?? changes[0])), Math.max(0, changes.length - 1))
  const change = changes[index]
  const selectedRows = rows.filter((row) => change != null && row.change === change)
  const sourceLine = selectedRows.find((row) => row.afterLine != null)?.afterLine ?? focus?.line ?? 1
  useLayoutEffect(() => {
    const pane = scroll.current
    if (mode === 'english' && englishReturn && pane) {
      pane.scrollTop = englishReturn.top
      pane.scrollLeft = englishReturn.left
      pane.querySelector<HTMLButtonElement>(`[data-side="${englishReturn.selection.side}"][data-source-line="${englishReturn.selection.line}"] button`)?.focus({ preventScroll: true })
      return
    }
    const active = scroll.current?.querySelector(selection
      ? `[data-side="${selection.side}"][data-source-line="${selection.line}"]` : '[data-selected="true"]')
    if (active instanceof HTMLElement) {
      active.scrollIntoView?.({ block: 'center' })
      if (selection && mode === 'code') active.focus({ preventScroll: true })
    }
  }, [change, mode, loading, selection, englishReturn])
  const assessments = data ? assessmentsForRows(data, selectedRows) : []
  const updateFocus = (line: number | undefined, nextMode = mode): void => onFocus?.({ file, line, mode: nextMode, ...(runId ? { baseline: 'run' } : {}) })
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
      updateFocus(focus?.line ?? sourceLine, nextMode)
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
      {baselineControl}
      <TestLanguageSwitch mode={mode} onChange={changeMode} />
      <div className="cl-review-change-nav" role="group" aria-label="Changes in this file">
        <button className="cl-icon-button" aria-label="Previous change" disabled={index === 0 || loading || !!error} onClick={() => navigate(index - 1)}>←</button>
        <span aria-live="polite">{loading ? 'Loading…' : error ? 'Unavailable' : changes.length ? `Change ${index + 1} of ${changes.length}` : 'No changes'}</span>
        <button className="cl-icon-button" aria-label="Next change" disabled={index >= changes.length - 1 || loading || !!error} onClick={() => navigate(index + 1)}>→</button>
      </div>
      <button className="cl-icon-button h-7 w-7" aria-label="Edit in editor" title="Edit this file in editor" disabled={!data || loading || !!error} onClick={() => {
        if (!data) return
        setEditorError(null)
        void api.openEditor({ file: data.currentPath, line: sourceLine }).then((result) => {
          if (!result.opened) setEditorError('Could not open the editor. Open this file in your workspace.')
        }).catch((err: unknown) => setEditorError(err instanceof Error ? err.message : 'Could not open editor'))
      }}>↗</button>
    </div>
    {error ? <div role="alert" className="flex-1 p-4 text-sm">{error}<button className="cl-button ml-3 px-3 py-1" onClick={() => setRetry(retry + 1)}>Retry</button></div>
      : loading || !data ? <div role="status" className="flex-1 p-4 text-sm text-secondary">Loading complete test source…</div>
      : <div className="cl-context-table min-h-0 flex-1"><SourceComparisonTable review={data} rows={rows} mode={mode} change={change} scrollRef={scroll}
        returnSelection={englishReturn?.selection} onReturnToEnglish={() => changeMode('english')}
        selection={selection} onSelectSource={(next) => {
          // A source click only exists while the comparison pane is mounted.
          const pane = scroll.current!
          setEnglishReturn({ selection: next, top: pane.scrollTop, left: pane.scrollLeft, cursor: index })
          setCursor(index); setSelection(next); setMode('code'); updateFocus(next.line, 'code')
        }} /></div>}
    <div className="cl-context-assessment" aria-live="polite">
      {editorError && <p role="alert" className="text-danger">{editorError}</p>}
      {!loading && !error && data && <>
      {data.assessment.reasons?.map((reason) => <p key={reason} className="text-warning">Cannot classify: {reason}</p>)}
      {data?.before.parseError || data?.after.parseError ? <p className="text-warning">English context is incomplete. Code includes the full source.</p> : null}
      {assessments.length ? <p><strong className="text-warning">{[...new Set(assessments.map((item) => item.verdict === 'unclassifiable' ? 'Cannot classify' : `${item.verdict[0].toUpperCase()}${item.verdict.slice(1)} · hint`))].join(' · ')}</strong>{' · '}{[...new Set(assessments.map((item) => item.reason ?? `${item.kind} assertion or execution guard`))].join('; ')}</p>
        : <p className="text-secondary">{changes.length ? 'Source edit · no assertion assessment.' : `This file matches ${runId ? 'the selected run snapshot' : 'Git HEAD'}.`}</p>}
      </>}
    </div>
  </>
}
