import type { ReactNode } from 'react'

interface Props {
  dirty: boolean
  saving: boolean
  error?: string | null
  savedAt?: number | null
  onSave: () => void
  onDiscard: () => void
  rightSlot?: ReactNode
}

/**
 * The footer chrome every feature-config tab ends with — same border, surface,
 * and padding whichever variant fills it, so switching tabs never moves the
 * modal's content edge.
 */
function FooterShell({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-2.5"
      style={{ borderTop: '1px solid var(--border-default)', background: 'var(--bg-base)' }}
    >
      {children}
    </div>
  )
}

/**
 * Read-only twin of {@link SaveBar}, for a tab that writes nothing (Ports): the
 * same footer, stating where the values ARE edited instead of offering Save /
 * Discard buttons that could never enable.
 *
 * The message carries the buttons' own vertical box metrics (`py-1` plus a
 * transparent 1px border), so this bar computes to exactly the height of the
 * editable one rather than to a hardcoded guess — tab switching shifts nothing.
 */
export function ReadOnlyBar({ children }: { children: ReactNode }) {
  return (
    <FooterShell>
      {/* Plain text flow, not a flex row: as a flex ITEM the span is blockified
          anyway, so the padding + border still set the height — and the prose
          keeps its natural spacing around inline <code> (a flex container would
          gap each text run apart, opening a space before a comma). */}
      <span
        className="min-w-0 py-1 text-[11px]"
        style={{ color: 'var(--text-muted)', border: '1px solid transparent' }}
      >
        {children}
      </span>
    </FooterShell>
  )
}

export function SaveBar({ dirty, saving, error, savedAt, onSave, onDiscard, rightSlot }: Props) {
  const showSavedFlash = !dirty && savedAt && Date.now() - savedAt < 4000
  return (
    <FooterShell>
      <div className="flex min-w-0 items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {error ? (
          <span style={{ color: 'var(--danger)' }}>{error}</span>
        ) : dirty ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'var(--warning)' }} />
            Unsaved changes
          </span>
        ) : showSavedFlash ? (
          <span style={{ color: 'var(--success)' }}>Saved.</span>
        ) : (
          <span>Up to date.</span>
        )}
        {rightSlot}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onDiscard}
          disabled={!dirty || saving}
          className="rounded-md px-3 py-1 text-[11px] uppercase tracking-wider transition-colors duration-150"
          style={{
            color: 'var(--text-muted)',
            border: '1px solid var(--border-default)',
            opacity: dirty && !saving ? 1 : 0.4,
            cursor: dirty && !saving ? 'pointer' : 'not-allowed',
          }}
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className="rounded-md px-3 py-1 text-[11px] uppercase tracking-wider transition-colors duration-150"
          style={{
            color: 'var(--accent)',
            border: '1px solid color-mix(in srgb, var(--accent) 40%, transparent)',
            background: dirty && !saving
              ? 'color-mix(in srgb, var(--accent) 14%, transparent)'
              : 'color-mix(in srgb, var(--accent) 4%, transparent)',
            opacity: dirty && !saving ? 1 : 0.5,
            cursor: dirty && !saving ? 'pointer' : 'not-allowed',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </FooterShell>
  )
}
