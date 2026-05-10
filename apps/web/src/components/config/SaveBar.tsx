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

export function SaveBar({ dirty, saving, error, savedAt, onSave, onDiscard, rightSlot }: Props) {
  const showSavedFlash = !dirty && savedAt && Date.now() - savedAt < 4000
  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-2.5"
      style={{ borderTop: '1px solid var(--border-default)', background: 'var(--bg-base)' }}
    >
      <div className="flex min-w-0 items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {error ? (
          <span style={{ color: '#ef4444' }}>{error}</span>
        ) : dirty ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: '#eab308' }} />
            Unsaved changes
          </span>
        ) : showSavedFlash ? (
          <span style={{ color: '#22c55e' }}>Saved.</span>
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
            color: 'var(--border-focus)',
            border: '1px solid color-mix(in srgb, var(--border-focus) 40%, transparent)',
            background: dirty && !saving
              ? 'color-mix(in srgb, var(--border-focus) 14%, transparent)'
              : 'color-mix(in srgb, var(--border-focus) 4%, transparent)',
            opacity: dirty && !saving ? 1 : 0.5,
            cursor: dirty && !saving ? 'pointer' : 'not-allowed',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
