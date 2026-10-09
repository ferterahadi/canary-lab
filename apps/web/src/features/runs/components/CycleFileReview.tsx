import { useId, useMemo, useState } from 'react'
import { cycleFileAlignedInput, type CycleReviewFile } from '@shared/test-view/cycle-review'
import { ComparisonLegend } from '@/shared/ui/ComparisonTable'
import { TestPresentation } from '@/shared/ui/TestPresentation'

const CODE_ONLY = { reason: 'English needs the whole file; this cycle is shown from its patch alone' }

/** One repair cycle's files, one at a time, through the same aligned view as
 * Compare test versions: real line numbers, changed words marked, and the
 * lines the patch leaves out counted between hunks. The chosen file is kept
 * by path, so a refreshed cycle keeps it while it still exists. */
export function CycleFileReview({ files, cycle }: { files: readonly CycleReviewFile[]; cycle: number }) {
  const pickerId = useId()
  const [chosen, setChosen] = useState<string | null>(null)
  const file = files.find((item) => item.path === chosen) ?? files[0]
  const input = useMemo(() => cycleFileAlignedInput(file, cycle), [file, cycle])
  const picker = files.length > 1 && (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <label htmlFor={pickerId} className="shrink-0 text-[11.5px] font-medium" style={{ color: 'var(--text-primary)' }}>File</label>
      <select id={pickerId} className="themed-select cl-input min-w-0 flex-1 px-2 py-1 text-xs" value={file.path} onChange={(event) => setChosen(event.target.value)}>
        {files.map((item) => <option key={item.path} value={item.path} title={item.repo}>{item.path}{item.change === 'modified' ? '' : ` · ${item.change}`}</option>)}
      </select>
    </span>
  )
  const ending = file.noNewlineAtEnd && [file.noNewlineAtEnd.before && 'before', file.noNewlineAtEnd.after && 'after'].filter(Boolean).join(' and ')
  if (!file.rows.length) {
    return <div className="rounded border" style={{ borderColor: 'var(--border-default)' }}>
      {picker && <div className="cl-context-toolbar">{picker}</div>}
      <p className="m-0 px-3 py-2 text-secondary" data-testid="cycle-file-without-rows">
        {file.change === 'binary' ? `${file.path} is a binary file; there is no text to compare.` : `${file.path} was renamed from ${file.previousPath} with no line edits.`}
      </p>
    </div>
  }
  return <div className="flex max-h-[420px] min-h-0 flex-col overflow-hidden rounded border" style={{ borderColor: 'var(--border-default)' }}>
    <TestPresentation view="aligned" {...input} mode="code" marks="word" codeOnly={CODE_ONLY} ariaLabel="Code changes before and after"
      header={<>{picker}<ComparisonLegend /></>}
      notice={(file.previousPath || ending) && <p className="m-0 px-3 py-1.5 text-secondary">
        {file.previousPath && `Renamed from ${file.previousPath}. `}{ending && `No newline at the end of the file ${ending} this cycle.`}
      </p>} />
  </div>
}
