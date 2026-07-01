import { useEffect, useState } from 'react'
import type { Feature } from '../../../shared/api/types'
import * as api from '../../../shared/api/client'

interface Props {
  features: Feature[]
  onClose: () => void
}

// Review panel for modified test files. Lists every feature whose specs diverged
// since the last green (or run-start) and offers the one sanctioned way to clear
// the cue: commit the change (stages + commits exactly the dirty specs for that
// feature — durable, on the git record). Chrome mirrors RunsListDialog so the
// panels read as a family. No enforcement — this is awareness; the user decides.
export function DirtyReviewDialog({ features, onClose }: Props) {
  const dirty = features.filter((f) => f.dirty?.status === 'dirty')
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<Record<string, string | undefined>>({})
  const [workspaceOpenError, setWorkspaceOpenError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // The list is fed by live feature data — once a feature clears it drops out on
  // its own. Close when nothing is left so the panel doesn't linger empty.
  useEffect(() => {
    if (dirty.length === 0) onClose()
  }, [dirty.length, onClose])

  // One global action for the whole panel — opens the workspace repo (not any
  // one file) in the project's configured editor, since every dirty spec here
  // lives in the same workspace.
  const openWorkspace = async (): Promise<void> => {
    setWorkspaceOpenError(null)
    try {
      const res = await api.openWorkspace()
      if (!res.opened) setWorkspaceOpenError(res.error ?? 'Failed to open editor')
    } catch (err) {
      setWorkspaceOpenError(err instanceof Error ? err.message : 'Failed to open editor')
    }
  }

  const commit = async (feature: string): Promise<void> => {
    setBusy((b) => ({ ...b, [feature]: true }))
    setError((e) => ({ ...e, [feature]: undefined }))
    try {
      await api.commitDirtySpecs(feature)
      // The tests-dirty-changed WS event refetches the feature list, which drops
      // this feature once it goes clean — no local state to clear.
    } catch (err) {
      setError((e) => ({ ...e, [feature]: err instanceof Error ? err.message : 'action failed' }))
    } finally {
      setBusy((b) => ({ ...b, [feature]: false }))
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-end bg-black/30 p-6" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Modified test files"
        className="flex max-h-[calc(100vh-3rem)] w-[min(560px,calc(100vw-3rem))] flex-col rounded-lg border shadow-2xl"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cl-dialog-header">
          <h2 className="min-w-0 flex-1 text-sm font-semibold" style={{ color: 'var(--danger)' }}>
            Tests modified
          </h2>
          <button
            type="button"
            title="Open workspace in editor"
            aria-label="Open workspace in editor"
            onClick={openWorkspace}
            className="cl-icon-button h-6 w-6 shrink-0 text-[12px]"
          >
            ↗
          </button>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs"
            style={{ color: 'var(--text-secondary)' }}
          >
            Close
          </button>
        </header>

        <div className="px-4 pt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          A test file changed since the last green run, so its verdicts aren&apos;t attested. Commit the
          change to clear the flag.
        </div>
        {workspaceOpenError && (
          <div className="px-4 pt-1 text-[11px]" style={{ color: 'var(--danger)' }}>{workspaceOpenError}</div>
        )}

        <div className="min-h-0 flex-1 overflow-auto p-3 scrollbar-thin">
          <ul className="flex flex-col gap-3">
            {dirty.map((f) => {
              const specs = f.dirty?.specs ?? []
              const isBusy = busy[f.name] ?? false
              return (
                <li
                  key={f.name}
                  className="rounded-lg border p-3"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)',
                    background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
                  }}
                >
                  <div className="mb-1 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {f.name}
                  </div>
                  <ul className="mb-2 flex flex-col gap-2">
                    {specs.map((s) => (
                      <li key={s.file}>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className="min-w-0 truncate text-[11px]"
                            style={{ fontFamily: 'var(--font-mono)', color: 'var(--danger)' }}
                            title={s.file}
                          >
                            {s.file}
                          </span>
                          <span className="cl-count-chip shrink-0">{s.affectedTests.length}</span>
                        </div>
                        {s.affectedTests.length > 0 && (
                          <ul
                            className="mt-1 flex flex-col gap-1 pl-3"
                            style={{ borderLeft: '1px solid var(--border-default)' }}
                          >
                            {s.affectedTests.map((t) => (
                              <li
                                key={t}
                                className="truncate text-[11px]"
                                style={{ color: 'var(--text-secondary)' }}
                                title={t}
                              >
                                {t}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                  {error[f.name] && (
                    <div className="mb-2 text-[11px]" style={{ color: 'var(--danger)' }}>{error[f.name]}</div>
                  )}
                  <button
                    type="button"
                    onClick={() => commit(f.name)}
                    disabled={isBusy}
                    className="cl-button px-2.5 py-1 text-xs"
                  >
                    {isBusy ? 'Committing…' : 'Commit changes'}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </section>
    </div>
  )
}
