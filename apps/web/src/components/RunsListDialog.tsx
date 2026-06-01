import { useEffect, useState } from 'react'
import type { RunDetail, RunIndexEntry, RunStatus } from '../api/types'
import { ChevronRightIcon, StatusDot, type StatusDotState } from './config/atoms'
import { useRunDetails, useRuns } from '../state/RunsContext'
import { shortTime } from '../lib/format'

interface Props {
  onClose: () => void
  onNavigateToRun: (feature: string, runId: string) => void
}

// Grouped view of every run across all features. With concurrency several can
// be active at once, so this is the single place to see them and jump into any
// one. Chrome mirrors the EvaluationExportTaskToast / WizardTaskStatus dialogs
// (right-anchored panel, bordered + shadowed surface, "Close" text button,
// leading status dot + pill chip) so the three run/task dialogs read as one
// family. Active runs (running / healing / queued) stay expanded; the long
// tail of finished runs collapses behind a disclosure so the active work is
// always what you see first.
const ACTIVE_GROUPS: Array<{ key: string; label: string; statuses: RunStatus[] }> = [
  { key: 'running', label: 'Running', statuses: ['running'] },
  { key: 'healing', label: 'Healing', statuses: ['healing'] },
  { key: 'queued', label: 'Queued', statuses: ['queued'] },
]
const FINISHED_STATUSES: RunStatus[] = ['passed', 'failed', 'aborted']

// Pill chip + leading dot palettes, keyed by run status. Colour families match
// RunStatusIndicator / WizardTaskStatus so the dialogs stay in sync.
const CHIP: Record<RunStatus, { bg: string; text: string }> = {
  running: { bg: 'rgba(14, 165, 233, 0.15)', text: 'rgb(56, 189, 248)' },
  healing: { bg: 'rgba(245, 158, 11, 0.15)', text: 'rgb(251, 191, 36)' },
  queued:  { bg: 'var(--bg-selected)', text: 'var(--text-secondary)' },
  passed:  { bg: 'rgba(16, 185, 129, 0.15)', text: 'rgb(52, 211, 153)' },
  failed:  { bg: 'rgba(244, 63, 94, 0.15)', text: 'rgb(251, 113, 133)' },
  aborted: { bg: 'var(--bg-selected)', text: 'var(--text-muted)' },
}

const DOT: Record<RunStatus, { state: StatusDotState; pulse: boolean }> = {
  running: { state: 'running', pulse: true },
  healing: { state: 'warning', pulse: true },
  queued:  { state: 'idle', pulse: false },
  passed:  { state: 'success', pulse: false },
  failed:  { state: 'failed', pulse: false },
  aborted: { state: 'idle', pulse: false },
}

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
  // Finished runs are the long tail — collapsed by default so active work leads.
  const [finishedOpen, setFinishedOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const navigate = (r: RunIndexEntry): void => { onNavigateToRun(r.feature, r.runId); onClose() }
  const finishedRuns = runs.filter((r) => FINISHED_STATUSES.includes(r.status))
  const hasActive = ACTIVE_GROUPS.some((g) => runs.some((r) => g.statuses.includes(r.status)))

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-end bg-black/30 p-6"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="All runs"
        className="flex max-h-[calc(100vh-3rem)] w-[min(560px,calc(100vw-3rem))] flex-col rounded-lg border shadow-2xl"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cl-dialog-header">
          <h2 className="min-w-0 flex-1 text-sm font-semibold">Runs</h2>
          <button
            type="button"
            aria-label="Close runs"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs"
            style={{ color: 'var(--text-secondary)' }}
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-2 scrollbar-thin">
          {runs.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
              No runs yet.
            </div>
          ) : (
            <>
              {ACTIVE_GROUPS.map((group) => {
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
                      {groupRuns.map((r) => (
                        <RunRow key={r.runId} run={r} detail={details[r.runId]} onSelect={navigate} />
                      ))}
                    </ul>
                  </section>
                )
              })}

              {finishedRuns.length > 0 && (
                <section className={hasActive ? 'mt-1' : ''}>
                  <button
                    type="button"
                    onClick={() => setFinishedOpen((v) => !v)}
                    aria-expanded={finishedOpen}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider transition-colors hover:bg-white/[0.03]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex transition-transform duration-150"
                      style={{ transform: finishedOpen ? 'rotate(90deg)' : 'none' }}
                    >
                      <ChevronRightIcon />
                    </span>
                    <span>Finished · {finishedRuns.length}</span>
                  </button>
                  {finishedOpen && (
                    <ul className="mt-1 flex flex-col gap-1">
                      {finishedRuns.map((r) => (
                        <RunRow key={r.runId} run={r} detail={details[r.runId]} onSelect={navigate} />
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function RunRow({
  run,
  detail,
  onSelect,
}: {
  run: RunIndexEntry
  detail: RunDetail | undefined
  onSelect: (run: RunIndexEntry) => void
}) {
  const ports = portsLabel(detail)
  const note = queueNote(run, detail)
  const dot = DOT[run.status]
  const meta: Array<{ text: string; mono?: boolean }> = [{ text: shortTime(run.startedAt) }]
  if (ports) meta.push({ text: ports, mono: true })
  if (note) meta.push({ text: note })
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(run)}
        className="group flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/[0.03]"
        title={`Go to run ${run.runId}`}
      >
        <StatusDot state={dot.state} pulse={dot.pulse} halo={dot.pulse} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px]" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
            {run.feature}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {meta.map((part, i) => (
              <span key={i} className="flex min-w-0 items-center gap-1.5">
                {i > 0 && <Sep />}
                <span
                  className={part.mono ? 'shrink-0' : 'truncate'}
                  style={part.mono ? { fontFamily: 'var(--font-mono)' } : undefined}
                >
                  {part.text}
                </span>
              </span>
            ))}
          </span>
        </span>
        <RunStatusChip status={run.status} />
        <span
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: 'var(--accent)' }}
          aria-hidden="true"
        >
          →
        </span>
      </button>
    </li>
  )
}

function RunStatusChip({ status }: { status: RunStatus }) {
  const palette = CHIP[status]
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ background: palette.bg, color: palette.text }}
    >
      {status}
    </span>
  )
}

function Sep() {
  return (
    <span aria-hidden="true" className="select-none" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
      ·
    </span>
  )
}
