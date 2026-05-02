/**
 * Modal folder picker. canary-lab is a local dev tool, so the picker can
 * navigate anywhere on the user's filesystem via /api/workspace/dirs.
 */
import { useEffect, useState } from 'react'
import * as api from '../../api/client'
import { ChevronRightIcon, FolderIcon } from './atoms'

interface Props {
  /** The path currently saved in the config — string literal absolute path
   *  or a `$expr` placeholder like `__dirname`. */
  value: string | { $expr: string } | null | undefined
  onChange: (absolutePath: string) => void
  placeholder?: string
  /** Override the modal title (e.g. for clone-target picking). */
  title?: string
  /** Override the confirm button label. */
  confirmLabel?: string
}

export function FolderPicker({ value, onChange, placeholder, title, confirmLabel }: Props) {
  const [open, setOpen] = useState(false)

  const display = (() => {
    if (value == null || value === '') return placeholder ?? 'Select a folder…'
    if (typeof value === 'object' && '$expr' in value) return value.$expr
    return value
  })()

  const initialPath = typeof value === 'string' && value !== '' ? value : ''

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          color: typeof value === 'string' && value !== '' || (value && typeof value === 'object' && '$expr' in value) ? 'var(--text-primary)' : 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <FolderIcon />
        <span className="truncate flex-1">{display}</span>
        <span style={{ color: 'var(--text-muted)' }} className="shrink-0">
          <ChevronRightIcon />
        </span>
      </button>

      {open && (
        <FolderPickerModal
          initialPath={initialPath}
          title={title ?? 'Select a folder'}
          confirmLabel={confirmLabel ?? 'Use this folder'}
          onCancel={() => setOpen(false)}
          onConfirm={(p) => {
            onChange(p)
            setOpen(false)
          }}
        />
      )}
    </>
  )
}

export function FolderPickerModal({
  initialPath,
  title,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  initialPath: string
  title: string
  confirmLabel: string
  onConfirm: (path: string) => void
  onCancel: () => void
}) {
  const [at, setAt] = useState<string>(initialPath)
  const [resp, setResp] = useState<api.WorkspaceDirsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.listWorkspaceDirs(at)
      .then((r) => { if (!cancelled) { setResp(r); setError(null) } })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to list directories')
      })
    return () => { cancelled = true }
  }, [at])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const current = resp?.absolute ?? at
  const parent = resp?.parent ?? null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onCancel}
    >
      <div
        className="flex w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-lg shadow-2xl"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          maxHeight: '80vh',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--border-default)' }}
        >
          <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
            {title}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            Esc
          </button>
        </div>

        {/* Path bar with parent button */}
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderBottom: '1px solid var(--border-default)' }}
        >
          <button
            type="button"
            disabled={!parent}
            onClick={() => parent && setAt(parent)}
            className="rounded px-2 py-1 text-xs"
            style={{
              color: parent ? 'var(--text-primary)' : 'var(--text-muted)',
              border: '1px solid var(--border-default)',
              opacity: parent ? 1 : 0.4,
              fontFamily: 'var(--font-mono)',
            }}
            title="Parent folder"
          >
            ..
          </button>
          <span
            className="flex-1 truncate text-xs"
            style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
            title={current}
          >
            {current}
          </span>
        </div>

        {/* Dir list */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {error && (
            <div className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              {error}
            </div>
          )}
          {!error && resp && resp.dirs.length === 0 && (
            <div className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              (no subdirectories)
            </div>
          )}
          {resp?.dirs.map((d) => (
            <button
              key={d}
              type="button"
              onDoubleClick={() => setAt(`${current.replace(/\/$/, '')}/${d}`)}
              onClick={() => setAt(`${current.replace(/\/$/, '')}/${d}`)}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs transition-colors duration-150"
              style={{ color: 'var(--text-secondary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--text-primary)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)' }}
            >
              <FolderIcon />
              <span style={{ fontFamily: 'var(--font-mono)' }}>{d}</span>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-3 py-2"
          style={{ borderTop: '1px solid var(--border-default)' }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-[11px] uppercase tracking-wider"
            style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!resp?.absolute}
            onClick={() => {
              if (!resp?.absolute) return
              onConfirm(resp.absolute)
            }}
            className="rounded-md px-3 py-1.5 text-[11px] uppercase tracking-wider"
            style={{
              color: 'var(--border-focus)',
              border: '1px solid color-mix(in srgb, var(--border-focus) 40%, transparent)',
              background: 'color-mix(in srgb, var(--border-focus) 8%, transparent)',
              opacity: resp?.absolute ? 1 : 0.4,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
