import { useEffect } from 'react'
import type { RunDetail, RunIndexEntry, RunStatus } from '../api/types'
import { CloseIcon } from './config/atoms'
import { RunStatusIndicator } from './RunStatusIndicator'
import { useRunDetails, useRuns } from '../state/RunsContext'
import { shortTime } from '../lib/format'

interface Props {
  onClose: () => void
  onNavigateToRun: (feature: string, runId: string) => void
}

// Grouped view of every run across all features. With concurrency, several can
// be active at once, so this is the single place to see them and jump into any
// one. Reuses the SettingsModal backdrop/modal pattern and the shared
// RunStatusIndicator so it stays visually consistent.
const GROUPS: Array<{ key: string; label: string; statuses: RunStatus[] }> = [
  { key: 'running', label: 'Running', statuses: ['running'] },
  { key: 'healing', label: 'Healing', statuses: ['healing'] },
  { key: 'queued', label: 'Queued', statuses: ['queued'] },
  { key: 'finished', label: 'Finished', statuses: ['passed', 'failed', 'aborted'] },
]

function portsLabel(detail: RunDetail | undefined): string | null {
  const ports = (detail?.manifest.services ?? [])
    .flatMap((s) => Object.values(s.allocatedPorts ?? {}))
  return ports.length > 0 ? ports.map((p) => `:${p}`).join(' ') : null
}

function queueNote(entry: RunIndexEntry, detail: RunDetail | undefined): string | null {
  if (entry.status !== 'queued') return null
  const reason = detail?.manifest.queueReason
  if (reason === 'repo-collision') return 'waiting for the same app to finish'
  if (reason === 'resources') return 'waiting for resources'
  return 'queued'
}

export function RunsListDialog({ onClose, onNavigateToRun }: Props) {
  const { runs } = useRuns()
  const details = useRunDetails()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="cl-modal-backdrop fixed inset-0 z-40 flex items-start justify-center p-4 pt-14"
      onClick={onClose}
    >
      <div
        className="cl-modal relative flex max-h-[calc(100vh-5rem)] w-[min(560px,100%)] flex-col overflow-hidden rounded-lg"
        style={{ background: 'var(--bg-elevated)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="All runs"
      >
        <header className="cl-dialog-header">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Runs</h2>
          </div>
          <button
            type="button"
            aria-label="Close runs"
            onClick={onClose}
            className="cl-icon-button h-7 w-7 shrink-0"
          >
            <CloseIcon size={14} />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto px-2 py-2">
          {runs.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
              No runs yet.
            </div>
          ) : (
            GROUPS.map((group) => {
              const groupRuns = runs.filter((r) => group.statuses.includes(r.status))
              if (groupRuns.length === 0) return null
              return (
                <section key={group.key} className="mb-2">
                  <div
                    className="px-2 py-1 text-[10px] uppercase tracking-wider"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {group.label} · {groupRuns.length}
                  </div>
                  <ul className="flex flex-col gap-1">
                    {groupRuns.map((r) => {
                      const detail = details[r.runId]
                      const ports = portsLabel(detail)
                      const note = queueNote(r, detail)
                      return (
                        <li key={r.runId}>
                          <button
                            type="button"
                            onClick={() => { onNavigateToRun(r.feature, r.runId); onClose() }}
                            className="cl-list-row flex w-full items-center gap-3 rounded-md px-3 py-2 text-left"
                            title={`Go to run ${r.runId}`}
                          >
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-[13px]" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                                {r.feature}
                              </span>
                              {note && (
                                <span className="truncate text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{note}</span>
                              )}
                            </span>
                            {ports && (
                              <span
                                className="shrink-0 text-[10.5px]"
                                style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                                title="Allocated ports"
                              >
                                {ports}
                              </span>
                            )}
                            <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              {shortTime(r.startedAt)}
                            </span>
                            <RunStatusIndicator status={r.status} />
                            <span className="shrink-0" style={{ color: 'var(--accent)' }} aria-hidden="true">→</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
