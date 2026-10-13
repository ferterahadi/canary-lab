import type { ReactNode } from 'react'

/** One labelled band of a result card: the label in a gutter, baseline-
 *  aligned to the first line of its value, hairlines between bands. The test
 *  result dialog's cards and the run's repo cards share it, so every card
 *  that explains a run reads as one layout. Render inside a `<dl>`. */
export function FieldRow({ label, mark, first = true, children }: { label: string; mark?: ReactNode; first?: boolean; children: ReactNode }) {
  return (
    <div className={`grid grid-cols-[76px_minmax(0,1fr)] items-baseline gap-3 px-3 py-2.5 text-xs leading-relaxed ${first ? '' : 'border-t'}`} style={{ borderColor: 'var(--border-default)' }}>
      <dt className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}{mark}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  )
}

/** A card's full-width band: a heading row on the rows' label gutter, then
 *  content edge to edge under a hairline. A repair's Changes and an
 *  execution's Code share it, so cards hold code the same way. */
export function Band({ label, title, aside, testId, children }: { label: string; title?: ReactNode; aside?: ReactNode; testId?: string; children?: ReactNode }) {
  return (
    <div className="border-t" style={{ borderColor: 'var(--border-default)' }} data-testid={testId}>
      <div className="grid grid-cols-[76px_minmax(0,1fr)_auto] items-baseline gap-3 px-3 py-2.5 text-xs">
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</span>
        <span className="min-w-0 truncate text-[11px]">{title}</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{aside}</span>
      </div>
      {children && <div className="border-t" style={{ borderColor: 'var(--border-default)' }}>{children}</div>}
    </div>
  )
}
