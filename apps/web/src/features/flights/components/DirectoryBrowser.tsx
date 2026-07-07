import { useCallback, useEffect, useState } from 'react'
import * as api from '../../../shared/api/client'
import type { DirectoryBrowseResult } from '../../../shared/api/client'
import { FolderIcon } from '../../config/components/atoms'

// R53: pick a repo DIRECTORY by absolute path. Browsers can't produce absolute
// paths, so the listing comes from the server (GET /api/fs/browse-dirs, home-
// rooted, dirs only). Dense + token-native, mirroring the EnvsetsTab file
// browser but scoped to directories and returning the *current folder* on pick.

export function DirectoryBrowser({
  initialPath,
  onPick,
  onCancel,
}: {
  /** Directory to open on mount (defaults to the user's home tree root). */
  initialPath?: string
  /** Called with the absolute path of the folder the user chose. */
  onPick: (path: string) => void
  onCancel: () => void
}) {
  const [result, setResult] = useState<DirectoryBrowseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The path we're currently trying to load — used to retry after an error
  // without losing where the user was.
  const [target, setTarget] = useState<string | undefined>(initialPath)

  const load = useCallback((path?: string) => {
    setLoading(true)
    setError(null)
    api
      .browseDirectory(path)
      .then((res) => {
        setResult(res)
        setLoading(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to list directory')
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    load(target)
  }, [load, target])

  const descend = (path: string): void => setTarget(path)
  const goUp = (): void => {
    if (result?.parent != null) setTarget(result.parent)
  }

  return (
    <div
      data-testid="dir-browser"
      className="flex flex-col rounded-md"
      style={{ border: '1px solid var(--border-default)' }}
    >
      {/* Header: current path + up */}
      <div
        className="flex items-center gap-2 px-2 py-1.5"
        style={{ borderBottom: '1px solid var(--border-default)' }}
      >
        <span
          className="min-w-0 flex-1 truncate text-[11px]"
          style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
          title={result?.path ?? target ?? ''}
        >
          {result?.path ?? target ?? '…'}
        </span>
        <button
          type="button"
          data-testid="dir-browser-up"
          onClick={goUp}
          disabled={!result || result.parent == null}
          className="cl-button shrink-0 px-1.5 py-0.5 text-[10px]"
          style={{ opacity: !result || result.parent == null ? 0.45 : 1 }}
          title="Up one folder"
        >
          ↑ up
        </button>
      </div>

      {/* List */}
      <div
        className="max-h-[200px] overflow-auto scrollbar-thin"
        style={{ scrollbarGutter: 'stable' }}
      >
        {loading && (
          <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Loading…
          </div>
        )}
        {!loading && error && (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px]" style={{ color: 'var(--danger)' }}>
            <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
            <button
              type="button"
              onClick={() => load(target)}
              className="cl-button shrink-0 px-1.5 py-0.5 text-[10px]"
              style={{ color: 'var(--text-primary)' }}
            >
              Retry
            </button>
          </div>
        )}
        {!loading && !error && result && result.entries.length === 0 && (
          <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            No sub-folders.
          </div>
        )}
        {!loading && !error && result &&
          result.entries.map((e) => (
            <button
              key={e.path}
              type="button"
              data-testid={`dir-browser-entry-${e.name}`}
              onClick={() => descend(e.path)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') {
                  ev.preventDefault()
                  descend(e.path)
                }
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
              style={{ color: 'var(--text-primary)' }}
              onMouseEnter={(ev) => { ev.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent' }}
            >
              <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>
                <FolderIcon />
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px]">{e.name}</span>
            </button>
          ))}
      </div>

      {/* Footer: use / cancel */}
      <div
        className="flex items-center justify-end gap-1.5 px-2 py-1.5"
        style={{ borderTop: '1px solid var(--border-default)' }}
      >
        <button
          type="button"
          data-testid="dir-browser-cancel"
          onClick={onCancel}
          className="cl-button px-2 py-1 text-[11px]"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="dir-browser-pick"
          onClick={() => { if (result) onPick(result.path) }}
          disabled={!result}
          className="cl-button-primary rounded-md px-2.5 py-1 text-[11px]"
          style={{ opacity: !result ? 0.5 : 1 }}
        >
          Use this folder
        </button>
      </div>
    </div>
  )
}
