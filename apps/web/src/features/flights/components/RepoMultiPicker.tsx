import { useState } from 'react'
import { DirectoryBrowser } from './DirectoryBrowser'

// R40: the flight dialog's repo selection — the ONE multi-repo picker (known
// workspace repos as toggle rows + a free path input for new ones). Selection
// order is preserved: the FIRST selected repo derives the feature slug.

export interface RepoOption {
  /** Display name (repo name from the feature config, or the path basename). */
  label: string
  /** Absolute local path — the value posted to /api/flights. */
  path: string
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function RepoMultiPicker({
  known,
  selected,
  onChange,
  disabled,
  disabledReason,
}: {
  known: RepoOption[]
  selected: string[]
  onChange: (paths: string[]) => void
  disabled?: boolean
  /** Shown when the picker is locked (e.g. "pause the flight to edit repos"). */
  disabledReason?: string
}) {
  const [pathInput, setPathInput] = useState('')
  const [browsing, setBrowsing] = useState(false)

  // Selected paths that aren't in the known list (added by hand) still render
  // as rows so they can be unpicked.
  const extras = selected
    .filter((p) => !known.some((k) => k.path === p))
    .map((p) => ({ label: basename(p), path: p }))
  const rows = [...known, ...extras]

  const toggle = (path: string): void => {
    if (disabled) return
    onChange(selected.includes(path) ? selected.filter((p) => p !== path) : [...selected, path])
  }

  // Add a repo path (from the text input by default, or an explicit path from
  // the Browse… picker). Both routes share this one code path so a browsed
  // folder behaves exactly like a typed-and-Added one.
  const addPath = (raw?: string): void => {
    const value = (raw ?? pathInput).trim()
    if (!value || disabled) return
    if (!selected.includes(value)) onChange([...selected, value])
    setPathInput('')
  }

  return (
    <div className="flex flex-col gap-1" data-testid="repo-multi-picker" style={{ opacity: disabled ? 0.55 : 1 }}>
      {/* Known + hand-added repos. Scrolls once the list is long; stable gutter
          keeps the appearing scrollbar from jumping the rows sideways. */}
      <div
        className="flex max-h-[220px] flex-col gap-1 overflow-y-auto scrollbar-thin"
        style={{ scrollbarGutter: 'stable' }}
      >
        {rows.map((repo) => {
          const checked = selected.includes(repo.path)
          return (
            <label
              key={repo.path}
              data-testid={`repo-pick-${repo.label}`}
              className="flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 transition-colors"
              style={{
                borderColor: checked ? 'var(--border-default)' : 'color-mix(in srgb, var(--border-default) 55%, transparent)',
                background: checked ? 'var(--bg-selected)' : undefined,
                cursor: disabled ? 'not-allowed' : undefined,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggle(repo.path)}
                className="h-3.5 w-3.5 shrink-0"
              />
              <span className="shrink-0 text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {repo.label}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-[10.5px]"
                style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                title={repo.path}
              >
                {repo.path}
              </span>
            </label>
          )
        })}
      </div>

      {!disabled && (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            data-testid="repo-pick-add-input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addPath()
              }
            }}
            placeholder="/path/to/another/repo"
            className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-[11px] outline-none"
            style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
          />
          <button
            type="button"
            data-testid="repo-pick-browse"
            onClick={() => setBrowsing((v) => !v)}
            className="cl-button px-2 py-1 text-xs"
            aria-expanded={browsing}
          >
            Browse…
          </button>
          <button
            type="button"
            data-testid="repo-pick-add"
            onClick={() => addPath()}
            disabled={pathInput.trim() === ''}
            className="cl-button px-2 py-1 text-xs"
            style={{ opacity: pathInput.trim() === '' ? 0.55 : 1 }}
          >
            Add
          </button>
        </div>
      )}

      {!disabled && browsing && (
        <DirectoryBrowser
          onPick={(path) => {
            addPath(path)
            setBrowsing(false)
          }}
          onCancel={() => setBrowsing(false)}
        />
      )}

      {disabled && disabledReason && (
        <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{disabledReason}</div>
      )}
    </div>
  )
}
