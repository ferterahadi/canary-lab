import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { sourceRows } from '@shared/test-source-diff'
import { cycleFileAlignedInput, type CycleAlignedInput, type CyclePatchOnlyReason, type CycleReviewFile } from '@shared/test-view/cycle-review'
import type { TestViewMode } from '@shared/test-view/render-model'
import { formatLocalDateTime } from '@/shared/lib/format'
import { ComparisonLegend } from '@/shared/ui/ComparisonTable'
import { TestPresentation } from '@/shared/ui/TestPresentation'

const APP_CODE = { reason: 'App code is shown as code; English is for the suite\'s own files' }

const PATCH_ONLY: Record<CyclePatchOnlyReason, string> = {
  'binary': 'This is a binary file',
  'truncated': 'The journal cut this cycle\'s diff at its size cap and the full patch was not kept',
  'no-tree': 'This cycle\'s diff names a tree the run did not record',
  'repo-missing': 'The repository that held this file is no longer on disk',
  'blob-missing': 'This file\'s versions are no longer in its repository\'s history',
  'chain-broken': 'The recorded cycles could not be replayed to this file\'s exact versions',
  'apply-failed': 'The recorded cycles could not be replayed to this file\'s exact versions',
  'mismatch': 'The recorded cycles could not be replayed to this file\'s exact versions',
}

/** Where the shown versions came from, for the caption under the table. */
function recoveryNote(file: CycleReviewFile): string {
  const { recovery } = file
  if (recovery.kind === 'reconstructed') return recovery.verified === 'blob' ? 'Full file rebuilt from the recorded cycles and checked against git\'s ids' : 'Full file rebuilt from the recorded cycles'
  if (recovery.kind === 'exact') return `Full file from git blob ${file.blobs![recovery.from === 'before-blob' ? 'before' : 'after']} in ${recovery.repo.split('/').pop()}`
  return 'Patch only'
}

/** One repair cycle's files, one at a time, through the same aligned view as
 * Compare test versions. A file whose full versions were recovered shows
 * whole, with English for the suite's own code and an edit navigator; one
 * known only from its patch keeps the hunks' line numbers and counts the
 * lines between them. The chosen file is kept by path and the reading format
 * across files, so a refreshed cycle keeps both. */
export function CycleFileReview({ files, cycle, caption }: { files: readonly CycleReviewFile[]; cycle: number; caption: ReactNode }) {
  const pickerId = useId()
  const [chosen, setChosen] = useState<string | null>(null)
  const [mode, setMode] = useState<TestViewMode>('code')
  const file = files.find((item) => item.path === chosen) ?? files[0]
  const picker = files.length > 1 && (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <label htmlFor={pickerId} className="shrink-0 text-[11.5px] font-medium" style={{ color: 'var(--text-primary)' }}>File</label>
      <select id={pickerId} className="themed-select cl-input min-w-0 flex-1 px-2 py-1 text-xs" value={file.path} onChange={(event) => setChosen(event.target.value)}>
        {files.map((item) => <option key={item.path} value={item.path} title={item.repo}>{item.path}{item.change === 'modified' ? '' : ` · ${item.change}`}</option>)}
      </select>
    </span>
  )
  const footer = <p className="mb-0 mt-2 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{caption} · {recoveryNote(file)}</p>
  if (!file.sources && !file.rows.length) {
    return <>
      <div className="rounded border" style={{ borderColor: 'var(--border-default)' }}>
        {picker && <div className="cl-context-toolbar">{picker}</div>}
        <p className="m-0 px-3 py-2 text-secondary" data-testid="cycle-file-without-rows">
          {file.change === 'binary' ? `${file.path} is a binary file; there is no text to compare.` : `${file.path} was renamed from ${file.previousPath} with no line edits.`}
        </p>
      </div>
      {footer}
    </>
  }
  return <>
    <CycleFileView key={file.path} file={file} cycle={cycle} mode={mode} onModeChange={setMode} picker={picker} />
    {footer}
  </>
}

/** Keyed by path, so the edit cursor starts at the first edit of each file. */
function CycleFileView({ file, cycle, mode, onModeChange, picker }: {
  file: CycleReviewFile
  cycle: number
  mode: TestViewMode
  onModeChange: (mode: TestViewMode) => void
  picker: ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const input = useMemo((): CycleAlignedInput => {
    const patched = cycleFileAlignedInput(file, cycle)
    if (!file.sources) return patched
    const { before, after, patch } = file.sources
    return { labels: patched.labels, review: { before, after, supportingFile: file.role !== 'spec' }, rows: sourceRows({ before, after, patch }) }
  }, [file, cycle])
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
  const codeOnly = file.recovery.kind === 'patch-only'
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
    ending && `No newline at the end of the file ${ending} this cycle.`,
  ].filter(Boolean).join(' ')
  const executed = file.executed
  const notice = (notes || executed?.kind === 'inert' || executed?.kind === 'adopted') && <div className="px-3 py-1.5">
    {notes && <p className="m-0 text-secondary">{notes}</p>}
    {executed?.kind === 'inert' && <p className="m-0" style={{ color: 'var(--semantic-attention)' }} data-testid="cycle-file-inert">
      Not executed by this run · Playwright ran the run&apos;s suite copy; this edit stayed in the live suite
    </p>}
    {executed?.kind === 'adopted' && <p className="m-0 text-secondary" data-testid="cycle-file-adopted">
      Adopted into the run&apos;s suite by {executed.by === 'human' ? 'a person' : 'the test-repair rule'} at {formatLocalDateTime(executed.at)}, then rerun
    </p>}
  </div>
  return <div className="cl-cycle-review flex max-h-[420px] min-h-0 flex-col overflow-hidden rounded border" style={{ borderColor: 'var(--border-default)' }}>
    <TestPresentation view="aligned" {...input} mode={mode} onModeChange={onModeChange} marks="word" codeOnly={codeOnly} lang={file.language}
      change={changes[index]} scrollRef={scrollRef} ariaLabel="Code changes before and after"
      emptySide={file.change === 'added' ? 'before' : file.change === 'deleted' ? 'after' : undefined}
      emptySideLabel={file.change === 'added' ? 'New file in this cycle — nothing on the Before side' : 'Deleted in this cycle — nothing on the After side'}
      header={<>{picker}{nav}<ComparisonLegend /></>}
      notice={notice} />
  </div>
}
