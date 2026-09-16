import type { ReactNode } from 'react'

/**
 * The header a full-screen view opens with.
 *
 * The app has three of these views — the coverage ledger, the benchmark window
 * and cleanup — and each had grown its own header, so one opened with a rubric
 * over a name, one with a stage chip, and one (cleanup) with no title at all:
 * a tab strip floating where the view's name should be, which left the screen
 * unable to say what it was. The geometry here is the coverage ledger's, since
 * that is the one the rest of the app's full-screen vocabulary was built on: a
 * `--bg-surface` band, a hairline under it, 10px/16px padding, the rubric voice
 * over a 13.5px name, and Close pinned right.
 *
 * `children` is the view's own control strip (cleanup's tab toggle), placed
 * between the name and Close so the title always holds the leading position.
 */
export function PageHeader({ rubric, title, children, onClose, closeLabel }: {
  /** Mono caps line over the name — what kind of screen this is. */
  rubric: string
  /** The screen's name. */
  title: string
  /** The view's own controls, between the name and Close. */
  children?: ReactNode
  onClose: () => void
  /** Accessible name for Close, when "Close" alone is ambiguous on the page. */
  closeLabel?: string
}) {
  return (
    <header
      className="flex shrink-0 items-center gap-3.5 px-4 py-2.5"
      style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}
    >
      <div className="flex min-w-0 flex-col" style={{ lineHeight: 1.18 }}>
        <span className="cl-rubric">{rubric}</span>
        <span className="truncate text-[13.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</span>
      </div>
      {children}
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel ?? 'Close'}
        className="cl-button ml-auto shrink-0 px-3 py-1.5"
      >
        Close <span aria-hidden="true">✕</span>
      </button>
    </header>
  )
}
