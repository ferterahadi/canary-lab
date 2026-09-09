import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TestFileReview } from '@shared/test-review'
import * as api from '@/shared/api/client'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { SourceComparisonTable } from '@/shared/ui/SourceComparisonTable'
import { TestLanguageSwitch } from '@/shared/ui/TestLanguageSwitch'
import { assessmentsForRows, sourceRows } from '@/shared/lib/test-review-model'
import type { ReviewFocus } from '@/shared/lib/workspace-view-state'
export type { ReviewFocus } from '@/shared/lib/workspace-view-state'

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
  useEffect(() => {
    const active = scroll.current?.querySelector('[data-selected="true"]')
    if (active instanceof HTMLElement) active.scrollIntoView?.({ block: 'center' })
  }, [change, mode, loading])
  const assessments = data ? assessmentsForRows(data, selectedRows) : []
  const updateFocus = (line: number | undefined, nextMode = mode): void => onFocus?.({ file, line, mode: nextMode, ...(runId ? { baseline: 'run' } : {}) })
  const navigate = (next: number): void => {
    setCursor(next)
    updateFocus(rows.find((row) => row.change === changes[next] && row.afterLine != null)?.afterLine)
  }
  return <>
    <div className="cl-context-toolbar">
      {baselineControl}
      <TestLanguageSwitch mode={mode} onChange={(value) => { setMode(value); updateFocus(focus?.line ?? sourceLine, value) }} />
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
      : <div className="cl-context-table min-h-0 flex-1"><SourceComparisonTable review={data} rows={rows} mode={mode} change={change} scrollRef={scroll} /></div>}
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
