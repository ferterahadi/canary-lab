import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SortKey } from './cleanup-rows'

// "Quick select" presets collapsed into a single dropdown so the toolbar stays
// one tidy row instead of a wrapping pile of buttons. Closes on outside-click
// or Escape.
export function QuickSelectMenu<T>({ presets, onSelect }: {
  presets: Array<{ label: string; predicate: (r: T) => boolean }>
  onSelect: (predicate: (r: T) => boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="cl-button px-2 py-0.5"
        style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 5 }}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Quick select <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="cl-popover"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20, minWidth: 190,
            padding: 4, display: 'flex', flexDirection: 'column',
          }}
        >
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              role="menuitem"
              onClick={() => { onSelect(p.predicate); setOpen(false) }}
              className="cl-menu-item"
              style={{ textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 12, padding: '6px 9px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function SortHeader({
  sortKey,
  label,
  align,
  sort,
  onSort,
}: {
  sortKey: SortKey
  label: string
  align?: 'right'
  sort: { key: SortKey; dir: 'asc' | 'desc' }
  onSort: (key: SortKey) => void
}) {
  const active = sort.key === sortKey
  return (
    // Right-aligned (numeric) columns get a left-padding floor so their
    // header/cells can never fuse with the right-aligned column before them.
    <th
      className={`cl-sort-th py-1 pr-3 select-none${align === 'right' ? ' pl-3' : ''}`}
      style={{ textAlign: align ?? 'left', cursor: 'pointer' }}
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          color: active ? 'var(--text-secondary)' : undefined,
        }}
      >
        {label}
        <span style={{ fontSize: 9, opacity: active ? 1 : 0.3 }}>
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '▾'}
        </span>
      </span>
    </th>
  )
}

// Centered empty / loading / error state, sized to roughly center in the body
// like the Log Cleanup layout. Reused across both views for a consistent feel.
export function CleanupEmptyState({ icon, title, hint, action }: {
  icon: ReactNode
  title: string
  hint?: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 px-6 text-center"
      style={{ minHeight: '55vh', animation: 'fm-fade-up 220ms ease-out both' }}
    >
      <span style={{ color: 'var(--text-muted)', opacity: 0.5 }}>{icon}</span>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>{title}</div>
      {hint && (
        <div style={{ maxWidth: 380, fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-muted)' }}>{hint}</div>
      )}
      {action && (
        <button type="button" onClick={action.onClick} className="cl-button mt-1 px-3 py-1" style={{ fontSize: 12 }}>
          {action.label}
        </button>
      )}
    </div>
  )
}

// git-worktree glyph: a branch forking off a trunk (two nodes + a merge point).
export function WorktreeGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M18 9.2c0 4-4 3.8-7 5.4" />
    </svg>
  )
}

export function FolderGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

export function WarnGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

// Slow-spinning ring for loading states (reuses the canary-pulse cadence feel).
export function SpinnerGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" style={{ animation: 'cl-spin 0.9s linear infinite' }}>
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  )
}
