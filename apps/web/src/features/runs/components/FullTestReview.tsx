import { useEffect, useMemo, useRef, useState } from 'react'
import type { TestFileReview } from '@shared/test-review'
import * as api from '@/shared/api/client'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { ComparisonLegend, ComparisonTable } from '@/shared/ui/ComparisonTable'
import { assessmentsForRows, englishLines, rowsForTest, sourceRows, testSelections } from '@/shared/lib/test-review-model'
import type { ReviewFocus } from '@/shared/lib/workspace-view-state'
export type { ReviewFocus } from '@/shared/lib/workspace-view-state'


export function FullTestReview({ feature, file, runId, focus, onFocus, revision }: {
  feature: string; file: string; runId?: string; focus?: ReviewFocus
  onFocus?: (focus: ReviewFocus) => void; revision?: string
}) {
  const refresh = useInvalidationKey('tests')
  const [data, setData] = useState<TestFileReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selection, setSelection] = useState<string | null>(focus?.file && !focus.line ? 'file' : null)
  const [mode, setMode] = useState<'english' | 'code'>(focus?.mode ?? 'english')
  const [cursor, setCursor] = useState(0)
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
  const allRows = useMemo(() => data ? sourceRows(data) : [], [data])
  const choices = useMemo(() => data ? testSelections(data, allRows) : [], [data, allRows])
  const selected = selection === 'file' ? undefined : choices.find((item) => item.key === selection)
    ?? choices.find((item) => item.side === 'after' && item.test.line === focus?.line)
    ?? choices.find((item) => data && rowsForTest(allRows, item, data).some((row) => row.change != null)) ?? choices[0]
  const context = data ? rowsForTest(allRows, selected, data) : []
  const changes = [...new Set(context.flatMap((row) => row.change == null ? [] : [row.change]))]
  const index = Math.min(cursor, Math.max(0, changes.length - 1))
  const change = changes[index]
  const english = useMemo(() => data ? { before: englishLines(data.before), after: englishLines(data.after) } : null, [data])
  const rows = context.map((row) => ({ ...row, fullSource: true, code: mode === 'code', selected: change != null && row.change === change, sourceChanged: row.change != null,
    before: mode === 'english' && row.beforeLine != null ? english?.before.get(row.beforeLine) ?? row.before : row.before,
    after: mode === 'english' && row.afterLine != null ? english?.after.get(row.afterLine) ?? row.after : row.after,
  }))
  const previousNavigation = useRef({ cursor, mode, selection })
  useEffect(() => {
    const previous = previousNavigation.current
    previousNavigation.current = { cursor, mode, selection }
    if (previous.selection !== selection) { if (scroll.current) scroll.current.scrollTop = 0; return }
    if (previous.cursor === cursor && previous.mode === mode) return
    const active = scroll.current?.querySelector('[data-selected="true"]')
    if (active instanceof HTMLElement) active.scrollIntoView?.({ block: 'center' })
  }, [change, cursor, mode, selection])
  const assessments = data ? assessmentsForRows(data, context.filter((row) => row.change === change && change != null)) : []
  const updateFocus = (line: number | undefined, nextMode = mode): void => onFocus?.({ file, line, mode: nextMode, ...(runId ? { baseline: 'run' } : {}) })
  return <>
    <div className="cl-context-toolbar">
      <div className="flex min-w-0 items-center gap-3">
        <h3 className="min-w-0 flex-1 truncate font-mono text-xs" title={file}>{file}</h3>
        <button className="cl-button px-2 py-1 text-xs" disabled={!data} onClick={() => {
          if (!data) return
          setEditorError(null)
          void api.openEditor({ file: data.currentPath, line: selected?.test.line ?? 1 }).then((result) => {
            if (!result.opened) setEditorError('Could not open the editor. Open this file in your workspace.')
          }).catch((err: unknown) => setEditorError(err instanceof Error ? err.message : 'Could not open editor'))
        }}>Edit in editor ↗</button>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <select className="cl-input min-w-0 flex-1 px-2 py-1 text-xs" aria-label="Test context" value={selection === 'file' ? 'file' : selected?.key ?? 'file'} onChange={(event) => {
          setSelection(event.target.value); setCursor(0)
          updateFocus(choices.find((item) => item.key === event.target.value)?.test.line)
        }}>
          <option value="file">Full file · includes shared setup</option>
          {choices.map((item) => <option key={item.key} value={item.key}>{item.side === 'before' ? 'Removed · ' : ''}{item.test.name} · line {item.test.line}</option>)}
        </select>
        <div className="flex shrink-0 gap-1" role="group" aria-label="Comparison language">
          {(['english', 'code'] as const).map((value) => <button key={value} className="cl-button px-3 py-1 text-xs" aria-pressed={mode === value} onClick={() => { setMode(value); updateFocus(selected?.test.line, value) }}>{value === 'english' ? 'English' : 'Code'}</button>)}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ComparisonLegend />
        <div className="flex items-center gap-2 text-xs">
          <button className="cl-button px-2 py-1" aria-label="Previous change" disabled={index === 0 || loading} onClick={() => setCursor(index - 1)}>←</button>
          <span className="min-w-28 text-center" aria-live="polite">{changes.length ? `Change ${index + 1} of ${changes.length}` : 'No changes'}</span>
          <button className="cl-button px-2 py-1" aria-label="Next change" disabled={index >= changes.length - 1 || loading} onClick={() => setCursor(index + 1)}>→</button>
        </div>
      </div>
    </div>
    {error ? <div role="alert" className="flex-1 p-4 text-sm">{error}<button className="cl-button ml-3 px-3 py-1" onClick={() => setRetry(retry + 1)}>Retry</button></div>
      : loading ? <div role="status" className="flex-1 p-4 text-sm text-secondary">Loading complete test source…</div>
      : <div className="cl-context-table min-h-0 flex-1"><ComparisonTable rows={rows} beforeLabel={`Before · ${data?.baseline === 'run-start' ? 'This run’s snapshot' : 'Committed'}`} afterLabel="After · Current workspace" ariaLabel="Full test comparison" scrollRef={scroll} /></div>}
    <div className="cl-context-assessment" aria-live="polite">
      {editorError && <p role="alert" className="text-danger">{editorError}</p>}
      {data?.assessment.reasons?.map((reason) => <p key={reason} className="text-warning">Cannot classify: {reason}</p>)}
      {data?.before.parseError || data?.after.parseError ? <p className="text-warning">English context is incomplete. Switch to Code to review the full source.</p> : null}
      <p className="font-medium">{assessments.length ? assessments.map((item) => item.verdict === 'unclassifiable' ? 'Cannot classify' : `${item.verdict[0].toUpperCase()}${item.verdict.slice(1)} · hint`).filter((label, i, values) => values.indexOf(label) === i).join(' · ') : changes.length ? 'Source changed · no assertion assessment for this change' : 'No edits in this context'}</p>
      <p className="text-secondary">{[...new Set(assessments.map((item) => item.reason ?? `${item.kind} assertion or execution guard`))].join('; ') || (changes.length ? 'Review the surrounding code to judge its effect.' : 'Choose another test or Full file to inspect shared setup.')} {mode === 'english' && changes.length > 0 ? 'Code shows the exact edit, including changes with identical English wording.' : 'Assessments do not change execution results.'}</p>
    </div>
  </>
}
