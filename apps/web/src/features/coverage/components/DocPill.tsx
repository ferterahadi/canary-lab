import { useState } from 'react'

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function DocPill({ relPath, dirPrefix, generated, sizeBytes, busy, onOpen, onRemove, removeTitle, linked, linkTarget, broken }: {
  relPath: string
  dirPrefix: string
  generated: boolean
  sizeBytes: number
  busy: boolean
  onOpen: () => void
  /** Omitted when the doc set is frozen (a summary exists) — the pill is read-only. */
  onRemove?: () => void
  removeTitle: string
  /** Symlinked doc — the user's original elsewhere is the live source (R44). */
  linked?: boolean
  linkTarget?: string
  /** Dangling symlink (its target moved) — dangerous tint, still deletable. */
  broken?: boolean
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      data-testid={`doc-pill-${relPath}`}
      className="flex items-center gap-2.5"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      title={`Open ${dirPrefix}${relPath} in editor`}
      style={{
        padding: '9px 11px',
        borderRadius: 'var(--radius-md)',
        background: hover ? 'var(--bg-selected)' : 'var(--bg-base)',
        border: `1px solid ${hover ? 'color-mix(in srgb, var(--text-muted) 38%, var(--border-default))' : 'var(--border-default)'}`,
        cursor: 'pointer',
        transition: 'background 120ms, border-color 120ms',
      }}
    >
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded"
        style={{
          background: 'color-mix(in srgb, var(--text-muted) 12%, transparent)',
          color: generated ? 'var(--accent)' : 'var(--text-secondary)',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.3 }} className="truncate" title={linked && linkTarget ? `↗ ${linkTarget}` : `${dirPrefix}${relPath}`}>
          <span style={{ color: broken ? 'var(--danger)' : 'var(--text-primary)', fontWeight: 600 }}>{relPath}</span>
          {linked && (
            <span
              data-testid={`doc-linked-${relPath}`}
              className="ml-1.5 rounded px-1 py-[1px] text-[9px] font-semibold"
              style={{ color: broken ? 'var(--danger)' : 'var(--accent)', border: `1px solid color-mix(in srgb, ${broken ? 'var(--danger)' : 'var(--accent)'} 40%, transparent)` }}
            >
              {broken ? 'link broken' : 'symlink ↗'}
            </span>
          )}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          {generated ? 'Generated PRD artifact' : linked ? 'Linked doc — the original stays the live source' : 'Source doc'} · {formatBytes(sizeBytes)}
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          data-testid={`remove-doc-${relPath}`}
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          disabled={busy}
          aria-label={`Remove ${relPath}`}
          title={removeTitle}
          className="cl-icon-button h-6 w-6 shrink-0"
          style={{ color: 'var(--text-muted)' }}
        >
          ✕
        </button>
      )}
    </div>
  )
}

export function EmptyDropzone({ onPick, dragging, busy, title = 'Add source docs' }: {
  onPick: () => void
  dragging: boolean
  busy: boolean
  /** Heading inside the zone — the coverage rail and the flight Requirements panel name their doc kind. */
  title?: string
}) {
  return (
    <button
      type="button"
      data-testid="empty-dropzone"
      onClick={onPick}
      disabled={busy}
      className="flex w-full flex-col items-center justify-center gap-2 text-center"
      style={{
        padding: '34px 16px',
        borderRadius: 'var(--radius-md)',
        border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--border-default)'}`,
        background: dragging ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'var(--bg-base)',
        cursor: 'pointer',
        transition: 'border-color 150ms, background 150ms',
      }}
    >
      <span
        aria-hidden="true"
        className="flex h-10 w-10 items-center justify-center rounded-full"
        style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        Drop spec, ticket, or notes files here — or click to browse. Accepts <code>.md</code>, <code>.txt</code>, <code>.pdf</code>, <code>.docx</code>.
      </span>
    </button>
  )
}
