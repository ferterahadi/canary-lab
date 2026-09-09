import { useMemo, type ReactNode, type Ref, type UIEventHandler } from 'react'
import { compareText, type TextPart } from '@/shared/lib/comparison-diff'

export type ComparisonRow =
  | { id: string; kind: 'section'; label: ReactNode }
  | { id: string; kind: 'message'; label: ReactNode; assessment?: ReactNode; message: ReactNode }
  | { id: string; kind?: 'values'; label?: ReactNode; assessment?: ReactNode; before: string | null; after: string | null; description?: ReactNode; code?: boolean; testId?: string; beforeLine?: number; afterLine?: number; selected?: boolean; sourceChanged?: boolean; fullSource?: boolean }

export function ComparisonTable({ rows, beforeLabel = 'Before', afterLabel = 'After', labelHeading = 'Change', code = false, ariaLabel = 'Before and after comparison', review = false, scrollRef, onScroll }: {
  rows: ComparisonRow[]
  beforeLabel?: string
  afterLabel?: string
  labelHeading?: string
  code?: boolean
  ariaLabel?: string
  review?: boolean
  scrollRef?: Ref<HTMLDivElement>
  onScroll?: UIEventHandler<HTMLDivElement>
}) {
  const labelled = review || rows.some((row) => row.kind !== 'section' && row.label != null)
  return <div ref={scrollRef} onScroll={onScroll} className={`cl-comparison-wrap${review ? ' cl-comparison-review' : ''}`}>
    <table className={`cl-comparison${code ? ' cl-comparison-code' : ''}`} aria-label={ariaLabel}>
      {review && <colgroup><col style={{ width: 120 }} /><col style={{ width: 140 }} /><col /><col /></colgroup>}
      <thead><tr>{labelled && <th scope="col" className="cl-comparison-label">{labelHeading}</th>}{review && <th scope="col">Assessment</th>}<th scope="col">{beforeLabel}</th><th scope="col">{afterLabel}</th></tr></thead>
      <tbody>{rows.map((row) => row.kind === 'section'
        ? <tr key={row.id} className="cl-comparison-section"><td colSpan={review ? 4 : labelled ? 3 : 2}>{row.label}</td></tr>
        : row.kind === 'message'
          ? <tr key={row.id}>{labelled && <th scope="row" className="cl-comparison-label">{row.label}</th>}{review && <td>{row.assessment}</td>}<td colSpan={2}>{row.message}</td></tr>
          : <ComparisonValueRow key={row.id} row={row} labelled={labelled} review={review} />)}</tbody>
    </table>
  </div>
}

function ComparisonValueRow({ row, labelled, review }: { row: Extract<ComparisonRow, { before: string | null }>; labelled: boolean; review: boolean }) {
  const parts = useMemo(() => compareText(row.before ?? '', row.after ?? ''), [row.before, row.after])
  return <tr id={row.id} data-testid={row.testId} data-selected={row.selected || undefined} data-source-changed={row.sourceChanged || undefined} className={row.code ? 'cl-comparison-code' : undefined}>
    {labelled && <th scope="row" className="cl-comparison-label">{row.label}{row.description && <p className="mt-1 font-normal text-secondary">{row.description}</p>}</th>}
    {review && <td>{row.assessment}</td>}
    <td>{row.beforeLine != null && <span className="cl-context-line">{row.beforeLine}</span>}<ComparisonValue fullSource={row.fullSource} value={row.before} parts={parts.before} side="before" changed={row.before !== row.after} /></td>
    <td>{row.afterLine != null && <span className="cl-context-line">{row.afterLine}</span>}<ComparisonValue fullSource={row.fullSource} value={row.after} parts={parts.after} side="after" changed={row.before !== row.after} /></td>
  </tr>
}

function ComparisonValue({ value, parts, side, changed, fullSource }: { fullSource?: boolean; value: string | null; parts: TextPart[]; side: 'before' | 'after'; changed: boolean }) {
  const Tag = side === 'before' ? 'del' : 'ins'
  return <div className="cl-comparison-value" data-side={side}>
    {fullSource && value === null ? <span className="sr-only">No corresponding line</span> : fullSource && value === '' ? <span aria-label="Blank line">{'\u00a0'}</span> : value === null ? <span className="cl-comparison-empty">Not present</span> : <>
      <span className="sr-only">{side === 'before' ? 'was ' : 'now '}</span>
      {value === '' ? (changed ? <Tag>Empty value</Tag> : <span className="cl-comparison-empty">Empty value</span>) : parts.map((part, index) => part.changed
        ? <Tag key={index} aria-label={`${side === 'before' ? 'Removed' : 'Added'}: ${part.text}`}>{part.text}</Tag>
        : <span key={index}>{part.text}</span>)}
    </>}
  </div>
}

export function ComparisonLegend() {
  return <p className="cl-comparison-legend"><span>− Removed</span><span>+ Added</span><span>Color describes edits, not test results.</span></p>
}
