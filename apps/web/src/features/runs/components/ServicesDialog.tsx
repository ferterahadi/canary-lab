import { useEffect, useState } from 'react'
import type { RunDetail, RunIndexEntry } from '../../../api/types'
import { useActiveBootSessions, useRun, useRuns } from '../state/RunsContext'
import { StatusDot } from '../../config/components/atoms'
import { RunDetailColumn } from './RunDetailColumn'

interface Props {
  onClose: () => void
}

// Global, self-contained home for boot-only sessions. Master-detail: the left
// rail lists held sessions; the right pane reuses RunDetailColumn to show the
// selected session's full detail (Overview / Run Logs / per-service Services
// logs). Boot never appears in the Runs list or column 3 — everything boot
// lives here, decoupled from runs.
export function ServicesDialog({ onClose }: Props) {
  const { sessions } = useActiveBootSessions()
  const { abort } = useRuns()
  const [picked, setPicked] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Default to the first session; fall back automatically when the picked one
  // is stopped (and leaves the active list).
  const selectedId = picked && sessions.some((s) => s.runId === picked)
    ? picked
    : sessions[0]?.runId ?? null

  const stopAll = (): void => { for (const s of sessions) void abort(s.runId) }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-end bg-black/30 p-6" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Services"
        className="flex max-h-[calc(100vh-3rem)] w-[min(960px,calc(100vw-3rem))] flex-col rounded-lg border shadow-2xl"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cl-dialog-header">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Services</h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Apps booted for manual testing · no Playwright
            </p>
          </div>
          {sessions.length > 0 && (
            <button type="button" onClick={stopAll} className="rounded px-2 py-1 text-xs" style={{ color: 'var(--danger)' }}>
              Stop all &amp; revert
            </button>
          )}
          <button type="button" aria-label="Close services" onClick={onClose} className="rounded px-2 py-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            Close
          </button>
        </header>

        {sessions.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            No services booted. Use a feature's <span style={{ color: 'var(--boot)' }}>Run ▸ Boot</span> to bring an app up.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* Left rail: session list */}
            <aside
              className="w-[232px] shrink-0 overflow-auto border-r p-2 scrollbar-thin"
              style={{ borderColor: 'var(--border-default)' }}
            >
              <ul className="flex flex-col gap-1">
                {sessions.map((s) => (
                  <li key={s.runId}>
                    <SessionRailRow
                      session={s}
                      selected={s.runId === selectedId}
                      onSelect={() => setPicked(s.runId)}
                      onStop={() => void abort(s.runId)}
                    />
                  </li>
                ))}
              </ul>
            </aside>

            {/* Right pane: the full rich detail for the selected session. */}
            <div className="min-w-0 flex-1">
              {selectedId ? <RunDetailColumn runId={selectedId} /> : null}
            </div>
          </div>
        )}

        <footer className="border-t px-4 py-2.5 text-[10.5px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
          Pick a session to read its per-service logs. Stop tears it down and reverts the envset.
        </footer>
      </section>
    </div>
  )
}

function sessionLabel(detail: RunDetail | undefined, status: string, stopping: boolean): string {
  if (stopping) return 'stopping…'
  if (status === 'queued') return 'queued'
  if (detail?.manifest.lifecycle?.phase === 'services-ready') return 'services up'
  return 'booting…'
}

function SessionRailRow({
  session,
  selected,
  onSelect,
  onStop,
}: {
  session: RunIndexEntry
  selected: boolean
  onSelect: () => void
  onStop: () => void
}) {
  // useRun loads + reads this session's detail (lifecycle phase, transient).
  const { detail, status, transient } = useRun(session.runId)
  const stopping = transient === 'aborting'
  const label = sessionLabel(detail, status ?? session.status, stopping)
  const booting = label !== 'services up'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
      aria-pressed={selected}
      className="cursor-pointer rounded-md px-2.5 py-2 transition-colors"
      style={{ background: selected ? 'var(--bg-selected)' : 'transparent' }}
    >
      <div className="flex items-center gap-2">
        <StatusDot state="booted" pulse={booting} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{session.feature}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
          style={{ background: 'var(--boot-soft)', color: 'var(--boot)' }}
        >
          {label}
        </span>
        <button
          type="button"
          disabled={stopping}
          onClick={(e) => { e.stopPropagation(); onStop() }}
          className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium disabled:opacity-60"
          style={{ color: 'var(--danger)' }}
          title="Stop & revert"
        >
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      </div>
    </div>
  )
}
