import type { ReactNode } from 'react'

// A vertical status-step list: a hairline connector rail threading one
// indicator per row — done ✓, active (pulsing sky), pending (hollow), warn /
// failed (amber / rose dot) — beside a bold title and an optional quiet
// sub-line. The shared shape behind the specs-coverage passes timeline and any
// stage panel that walks a sequence of sub-steps, so those surfaces read as one
// family instead of a pile of hand-rolled lists. Palette matches the shared
// StatusDot atom; kept dependency-free (own dots via the global cl-status-dot
// class) so it lives in shared/ui without reaching back into a feature.

export type StepState = 'done' | 'active' | 'pending' | 'warn' | 'failed'

const DOT_CLASS: Record<Exclude<StepState, 'pending' | 'done'>, string> = {
  active: 'bg-running animate-pulse',
  warn: 'bg-warning',
  failed: 'bg-danger',
}

const TITLE_COLOR: Record<StepState, string> = {
  done: 'var(--text-primary)',
  active: 'var(--running)',
  warn: 'var(--warning)',
  failed: 'var(--danger)',
  pending: 'var(--text-muted)',
}

/** The rail + row stack. Pass `StepRow`s as children. */
export function StepList({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <ol data-testid={testId} className="relative m-0 flex list-none flex-col gap-2 p-0">
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-2.5 left-[7px] top-2.5 w-px"
        style={{ background: 'var(--border-default)' }}
      />
      {children}
    </ol>
  )
}

/** One step. The 15px indicator cell masks the rail behind it so the dots read
 *  as beads on the line. `done` fills the cell with a tinted check; the live /
 *  warn / failed states drop a 10px status dot; `pending` is a hollow ring. */
export function StepRow({ state, title, sub, testId }: {
  state: StepState
  title: ReactNode
  sub?: ReactNode
  testId?: string
}) {
  const cellBg = state === 'done' ? 'color-mix(in srgb, var(--success) 20%, transparent)' : 'var(--bg-surface)'
  return (
    <li data-testid={testId} className="relative flex gap-2.5 text-[11.5px]">
      <span
        aria-hidden
        className="relative z-[1] mt-[2px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full"
        style={{ background: cellBg }}
      >
        {state === 'done' ? (
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6.3l2.4 2.4L9.5 3.6" stroke="var(--success)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : state === 'pending' ? (
          <span className="h-[9px] w-[9px] rounded-full border" style={{ borderColor: 'var(--border-strong)' }} />
        ) : (
          <span className={`cl-status-dot ${DOT_CLASS[state]}`} />
        )}
      </span>
      <div className="min-w-0">
        <div className={state === 'pending' ? '' : 'font-medium'} style={{ color: TITLE_COLOR[state] }}>{title}</div>
        {sub ? <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{sub}</div> : null}
      </div>
    </li>
  )
}
