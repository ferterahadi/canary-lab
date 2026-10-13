import type { ReactNode } from 'react'

/** A titled band over its body — the run panes' card anatomy. */
export function ResultSection({ title, mark, context, action, testId, children }: {
  title: string
  /** A hint beside the title, about the section as a whole. */
  mark?: ReactNode
  context?: string
  action?: ReactNode
  testId?: string
  children: ReactNode
}) {
  return (
    <section className="cl-card overflow-hidden" aria-label={title} data-testid={testId}>
      <header className="cl-card-head flex-wrap">
        <h3 className="m-0 text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
        {mark}
        {context && <span className="min-w-0 truncate text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{context}</span>}
        <span className="min-w-2 flex-1" />
        {action}
      </header>
      {children}
    </section>
  )
}
