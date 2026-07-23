/**
 * Modal folder picker. canary-lab is a local dev tool, so the picker can
 * navigate anywhere on the user's filesystem via /api/workspace/dirs.
 */
import { useEffect, useState } from 'react'
import * as api from '../../../shared/api/client'
import { ChevronRightIcon, FolderIcon, Modal } from './atoms'

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

/** The "parent (`../`) + entries" list shared by every filesystem browser in
 *  the app — `FolderPickerModal` below (directories only, via
 *  `listWorkspaceDirs`) and the file pickers in `EnvsetsTab` (dirs + files,
 *  via `browseDir` — a different endpoint since those need to select a
 *  specific file, not just land on a folder). The two APIs return different
 *  shapes, so this only shares the list rendering, not the data fetch. */
export function FileBrowserList({
  browse,
  onNavigate,
  onPickFile,
  minHeight = 260,
  maxHeightVh = 50,
}: {
  browse: api.FsBrowseResponse | null
  onNavigate: (dir: string) => void
  /** Called with the picked file's full absolute path. */
  onPickFile: (fullPath: string) => void
  minHeight?: number
  maxHeightVh?: number
}) {
  return (
    <div
      className="overflow-y-auto scrollbar-thin rounded-md"
      style={{ border: '1px solid var(--border-default)', maxHeight: `${maxHeightVh}vh`, minHeight }}
    >
      {browse?.parent && (
        <button
          type="button"
          onClick={() => onNavigate(browse.parent!)}
          className="block w-full truncate px-3 py-1.5 text-left text-xs"
          style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
        >
          ../
        </button>
      )}
      {browse?.entries.map((e) => (
        <button
          key={e.name}
          type="button"
          onClick={() => {
            const full = `${browse.dir}/${e.name}`.replace(/\/+/g, '/')
            if (e.isDir) onNavigate(full)
            else onPickFile(full)
          }}
          className="block w-full truncate px-3 py-1.5 text-left text-xs hover:opacity-80"
          style={{ color: e.isDir ? 'var(--text-primary)' : 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
        >
          {e.isDir ? `${e.name}/` : e.name}
        </button>
      ))}
      {browse && browse.entries.length === 0 && (
        <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>Empty directory.</div>
      )}
    </div>
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

  const current = resp?.absolute ?? at
  const parent = resp?.parent ?? null

  return (
    <Modal
      open
      onClose={onCancel}
      title={title}
      width={560}
      testId="folder-picker-modal"
      subheader={
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderBottom: '1px solid var(--border-default)' }}
        >
          <button
            type="button"
            disabled={!parent}
            onClick={() => parent && setAt(parent)}
            className="cl-button rounded px-2 py-1 text-xs"
            style={{
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
      }
      footer={
        <>
          <button
            type="button"
            data-testid="folder-picker-cancel"
            onClick={onCancel}
            className="cl-button px-3 py-1 text-xs"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="folder-picker-confirm"
            disabled={!resp?.absolute}
            onClick={() => {
              if (!resp?.absolute) return
              onConfirm(resp.absolute)
            }}
            className="cl-button-primary px-3.5 py-1 text-xs"
          >
            {confirmLabel}
          </button>
        </>
      }
    >
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
    </Modal>
  )
}
