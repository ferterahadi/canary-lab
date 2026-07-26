import { useState } from 'react'
import { IconButton, PlusIcon, TrashIcon } from '@/features/config/components/atoms'
import { FolderPicker, FolderPickerModal } from '@/features/config/components/FolderPicker'

// R40/R69: the flight dialog's repo selection — the SAME building blocks Feature
// configuration uses. Each selected repo is a `FolderPicker` button (shows the
// path, click re-opens the shared modal to change it in place); "Add repo"
// appends another via the same modal. No bespoke browser, no layout shift.
// (The full RepoCard can't be reused here — it's bound to an existing feature's
// config doc, and a new flight has no feature yet.) Order is preserved: the
// FIRST repo derives the feature slug.

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
  selected,
  onChange,
  disabled,
  disabledReason,
}: {
  selected: string[]
  onChange: (paths: string[]) => void
  disabled?: boolean
  /** Shown when the picker is locked (e.g. "pause the flight to edit repos"). */
  disabledReason?: string
}) {
  const [picking, setPicking] = useState(false)

  // Change repo `i` to `path` (from its own FolderPicker), dropping duplicates
  // and keeping order.
  const replace = (i: number, path: string): void => {
    if (disabled || !path) return
    const next = selected.map((p, j) => (j === i ? path : p)).filter((p, j, arr) => arr.indexOf(p) === j)
    onChange(next)
  }
  const add = (path: string): void => {
    if (!disabled && path && !selected.includes(path)) onChange([...selected, path])
    setPicking(false)
  }
  const remove = (path: string): void => {
    if (!disabled) onChange(selected.filter((p) => p !== path))
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="repo-multi-picker" style={{ opacity: disabled ? 0.55 : 1 }}>
      {selected.map((path, i) => (
        <div key={path} data-testid={`repo-row-${basename(path)}`} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <FolderPicker
              value={path}
              onChange={(next) => replace(i, next)}
              title="Select a repo folder"
              confirmLabel="Use this folder"
            />
          </div>
          {!disabled && (
            <IconButton ariaLabel={`Remove ${basename(path)}`} variant="danger" onClick={() => remove(path)}>
              <TrashIcon />
            </IconButton>
          )}
        </div>
      ))}

      {!disabled && (
        <button
          type="button"
          data-testid="repo-pick-add"
          onClick={() => setPicking(true)}
          className="cl-button cl-rubric self-start inline-flex items-center gap-1.5 px-2.5 py-1.5"
          style={{ borderStyle: 'dashed', background: 'transparent' }}
        >
          <PlusIcon />
          Add repo
        </button>
      )}

      {/* Reused from Feature configuration — the single folder-picker home. */}
      {picking && (
        <FolderPickerModal
          initialPath=""
          title="Select a repo folder"
          confirmLabel="Add repo"
          onCancel={() => setPicking(false)}
          onConfirm={add}
        />
      )}

      {disabled && disabledReason && (
        <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{disabledReason}</div>
      )}
    </div>
  )
}
