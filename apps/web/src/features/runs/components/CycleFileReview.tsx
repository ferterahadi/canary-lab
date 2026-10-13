import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { sourceRows } from '@shared/test-source-diff'
import { cycleFileAlignedInput, type CycleAlignedInput, type CyclePatchOnlyReason, type CycleReviewFile } from '@shared/test-view/cycle-review'
import type { TestViewMode } from '@shared/test-view/render-model'
import { ComparisonLegend } from '@/shared/ui/ComparisonTable'
import { TestPresentation } from '@/shared/ui/TestPresentation'

const APP_CODE = { reason: 'App code is shown as code; English is for the suite\'s own files' }
const RUN_PATCH = { reason: 'A run\'s patch holds only the changed lines, so it shows as code' }
const RUN_LABELS = { before: 'Before this run', after: 'After this run' }
const SPAN_NOUN = { cycle: 'repair', run: 'run' } as const

const PATCH_ONLY: Record<CyclePatchOnlyReason, string> = {
  'binary': 'This is a binary file',
  'truncated': 'The journal cut this repair\'s diff at its size cap and the full patch was not kept',
  'no-tree': 'This repair\'s diff names a tree the run did not record',
  'repo-missing': 'The repository that held this file is no longer on disk',
  'blob-missing': 'This file\'s versions are no longer in its repository\'s history',
  'chain-broken': 'The recorded cycles could not be replayed to this file\'s exact versions',
  'apply-failed': 'The recorded cycles could not be replayed to this file\'s exact versions',
  'mismatch': 'The recorded cycles could not be replayed to this file\'s exact versions',
}

/** One repair cycle's files, one at a time, through the same aligned view as
 * Compare test versions. A file whose full versions were recovered shows
 * whole, with English for the suite's own code and an edit navigator; one
 * known only from its patch keeps the hunks' line numbers and counts the
 * lines between them. The chosen file is kept by path and the reading format
 * across files, so a refreshed cycle keeps both. */
export function CycleFileReview({ files, cycle, span = 'cycle', bare = false }: {
  files: readonly CycleReviewFile[]
  cycle: number
  /** What the before/after sides bracket: one repair cycle, or a whole run's
   *  captured patch (every cycle at once, read from its patch alone). */
  span?: 'cycle' | 'run'
  /** Inside a card band: the band's hairlines frame it, so it drops its own
   *  border and corners. */
  bare?: boolean
}) {
  const pickerId = useId()
  const [chosen, setChosen] = useState<string | null>(null)
  const [mode, setMode] = useState<TestViewMode>('code')
  const file = files.find((item) => item.path === chosen) ?? files[0]
  const picker = files.length > 1 && (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {/* The picker shows a path, so it needs no visible caption. */}
      <label htmlFor={pickerId} className="sr-only">File</label>
      <select id={pickerId} className="themed-select cl-input min-w-0 flex-1 px-2 py-1 text-xs" value={file.path} onChange={(event) => setChosen(event.target.value)}>
        {files.map((item) => <option key={item.path} value={item.path} title={item.repo}>{item.path}{item.change === 'modified' ? '' : ` · ${item.change}`}</option>)}
      </select>
    </span>
  )
  if (!file.sources && !file.rows.length) {
    return <div className={bare ? '' : 'rounded border'} style={{ borderColor: 'var(--border-default)' }}>
      {picker && <div className="cl-context-toolbar">{picker}</div>}
      <p className="m-0 px-3 py-2 text-secondary" data-testid="cycle-file-without-rows">
        {file.change === 'binary' ? `${file.path} is a binary file; there is no text to compare.` : `${file.path} was renamed from ${file.previousPath} with no line edits.`}
      </p>
    </div>
  }
  return <CycleFileView key={file.path} file={file} cycle={cycle} span={span} mode={mode} onModeChange={setMode} picker={picker} bare={bare} />
}

/** Keyed by path, so the edit cursor starts at the first edit of each file. */
function CycleFileView({ file, cycle, span, mode, onModeChange, picker, bare }: {
  file: CycleReviewFile
  cycle: number
  span: 'cycle' | 'run'
  mode: TestViewMode
  onModeChange: (mode: TestViewMode) => void
  picker: ReactNode
  bare: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const input = useMemo((): CycleAlignedInput => {
    const cyclePatch = cycleFileAlignedInput(file, cycle)
    const patched = span === 'run' ? { ...cyclePatch, labels: RUN_LABELS } : cyclePatch
    if (!file.sources) return patched
    const { before, after, patch } = file.sources
    return { labels: patched.labels, review: { before, after, supportingFile: file.role !== 'spec' }, rows: sourceRows({ before, after, patch }) }
  }, [file, cycle, span])
  const changes = useMemo(() => file.sources ? [...new Set(input.rows.flatMap((row) => row.change == null ? [] : [row.change]))] : [], [file.sources, input.rows])
  // English folds the rows differently, so a format switch re-centres too.
  // One English row can be taller than the panel; it then opens at its top,
  // where its first sentence is.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const row = scroller?.querySelector<HTMLElement>('[data-selected="true"]')
    if (!changes.length || !row) return
    row.scrollIntoView?.({ block: row.offsetHeight > scroller!.clientHeight ? 'start' : 'center', behavior: 'instant' })
  }, [changes.length, index, mode])
  // The server sends no sources exactly when a file is patch-only.
  const codeOnly = span === 'run'
    ? RUN_PATCH
    : file.recovery.kind === 'patch-only'
    ? { reason: `${PATCH_ONLY[file.recovery.reason]}; showing the patch alone` }
    : file.role === 'app' ? APP_CODE : undefined
  const nav = changes.length > 0 && (
    <div className="cl-review-change-nav" role="group" aria-label="Edit blocks in this file" title="Each block is a consecutive group of edited lines in this file.">
      <button type="button" className="cl-icon-button" aria-label="Previous change" disabled={index === 0} onClick={() => setIndex(index - 1)}>←</button>
      <span aria-live="polite">Edit {index + 1} / {changes.length}</span>
      <button type="button" className="cl-icon-button" aria-label="Next change" disabled={index >= changes.length - 1} onClick={() => setIndex(index + 1)}>→</button>
    </div>
  )
  const ending = file.noNewlineAtEnd && [file.noNewlineAtEnd.before && 'before', file.noNewlineAtEnd.after && 'after'].filter(Boolean).join(' and ')
  const notes = [
    file.previousPath && `Renamed from ${file.previousPath}.`,
    span === 'cycle' && ending && `No newline at the end of the file ${ending} this repair.`,
  ].filter(Boolean).join(' ')
  const executed = file.executed
  const notice = (notes || executed?.kind === 'inert') && <div className="px-3 py-1.5 text-[11px]">
    {notes && <p className="m-0 text-secondary">{notes}</p>}
    {executed?.kind === 'inert' && <p className="m-0" style={{ color: 'var(--semantic-attention)' }} data-testid="cycle-file-inert">
      Not executed by this run · Playwright ran the run&apos;s suite copy; this edit stayed in the live suite
    </p>}
  </div>
  return <div className={`cl-cycle-review flex max-h-[420px] min-h-0 flex-col overflow-hidden${bare ? '' : ' rounded border'}`} style={{ borderColor: 'var(--border-default)' }}>
    <TestPresentation view="aligned" {...input} mode={mode} onModeChange={onModeChange} marks="word" codeOnly={codeOnly} lang={file.language}
      change={changes[index]} scrollRef={scrollRef} ariaLabel="Code changes before and after"
      emptySide={file.change === 'added' ? 'before' : file.change === 'deleted' ? 'after' : undefined}
      emptySideLabel={file.change === 'added' ? `New file in this ${SPAN_NOUN[span]} — nothing on the Before side` : `Deleted in this ${SPAN_NOUN[span]} — nothing on the After side`}
      header={<>{picker}{nav}<ComparisonLegend /></>}
      notice={notice} />
  </div>
}
