import type { PortifyStatus } from '@/shared/api/client'

// Guided port-ification: an agent rewrites the feature's apps to use injectable
// ports, proven by a concurrent double-boot, ending when the user SAVES the
// verified edits as the feature's ephemeral overlay (a captured patch under
// features/<feature>/portify/). Nothing is committed or merged — at run time
// the overlay is applied into a per-run worktree and reverse-applied at
// teardown. Full-screen overlay mirroring the benchmark window; auto-polls.

// Review and Save are one screen (diff + proof + the overlay confirmation once
// saved), so the stepper has one node for both — the saved ✓ lands on it.
export const STEPS: { key: string; label: string; sub: string }[] = [
  { key: 'plan', label: 'Plan', sub: 'what changes' },
  { key: 'exercise', label: 'Exercise', sub: 'agent + verify' },
  { key: 'review', label: 'Review', sub: 'diff + save' },
]

export function stepIndexFor(phase: 'plan' | PortifyStatus): number {
  switch (phase) {
    case 'plan': return 0
    case 'planning':
    case 'editing':
    case 'verifying': return 1
    case 'ready-to-save':
    case 'failed':
    case 'saved': return 2
    default: return 1
  }
}

export const STATUS_LABEL: Record<PortifyStatus, string> = {
  planning: 'Setting up scratch worktree…',
  editing: 'Agent is rewriting ports…',
  verifying: 'Booting twice on different ports…',
  'ready-to-save': 'Verified — ready to save',
  saved: 'Saved — boots concurrently from now on',
  failed: 'Could not make it work',
  aborted: 'Cancelled',
}

/** Status reached a point where polling stops (parked for the user or terminal). */
export function isTerminalOrParked(s: PortifyStatus): boolean {
  return s === 'ready-to-save' || s === 'saved' || s === 'failed' || s === 'aborted'
}

/** The saved terminal state. */
export function isSaved(s: PortifyStatus | undefined): boolean {
  return s === 'saved'
}

/** Review reached → stepper navigation is enabled. */
export function isNavigable(s: PortifyStatus | undefined): boolean {
  return s === 'ready-to-save' || s === 'saved'
}

export const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
}

export function Stepper({
  current,
  reachedMax,
  saved,
  navigable,
  onStep,
}: {
  /** The step currently being viewed (gets the accent highlight). */
  current: number
  /** Furthest step the workflow itself has reached (status-derived). */
  reachedMax: number
  /** Whether the overlay has been saved (✓ on the Save step). */
  saved: boolean
  /** Whether step navigation is enabled (Review reached). */
  navigable: boolean
  onStep: (i: number) => void
}) {
  // A step is clickable once Review is reached, for any reached step except
  // Plan (the pre-start screen has no destination for an existing run).
  const isClickable = (i: number): boolean => navigable && i >= 1 && i <= reachedMax
  const SAVE_STEP = 2
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
      {STEPS.map((s, i) => {
        const reached = i <= reachedMax
        const isCurrent = i === current
        const clickable = isClickable(i)
        const showSavedTick = saved && i === SAVE_STEP
        const circleColor = showSavedTick ? 'var(--success)' : isCurrent || reached ? 'var(--accent)' : 'var(--text-muted)'
        const inner = (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: reached ? 1 : 0.45 }}>
            <span style={{
              width: 20, height: 20, borderRadius: 9999, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
              border: `2px solid ${showSavedTick ? 'var(--success)' : isCurrent || reached ? 'var(--accent)' : 'var(--border-default)'}`,
              color: circleColor,
              background: isCurrent ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
            }}>{showSavedTick ? '✓' : i + 1}</span>
            <span style={{ fontSize: 12 }}>
              <b style={{ color: isCurrent ? 'var(--accent)' : 'var(--text-primary)' }}>{s.label}</b>
              <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                {showSavedTick ? 'saved ✓' : s.sub}
              </span>
            </span>
          </div>
        )
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center' }}>
            {clickable ? (
              <button
                type="button"
                onClick={() => onStep(i)}
                title={`Go to ${s.label}`}
                aria-current={isCurrent ? 'step' : undefined}
                style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                {inner}
              </button>
            ) : (
              inner
            )}
            {i < STEPS.length - 1 && <span style={{ width: 40, height: 2, background: 'var(--border-default)', margin: '0 12px' }} />}
          </div>
        )
      })}
    </div>
  )
}
