import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FlightIndexEntry, FlightStageStatus, FlightStatus } from '../../../shared/api/client'
import { StatusDot } from '../../config/components/atoms'
import { FLIGHT_STAGE_KEYS } from '../../../../../../shared/flights/types'

// Flights pill — an always-visible launcher for First Flight (`canary-lab fly`)
// progress. Idle it's a neutral launcher; while a flight runs it takes the
// in-flight treatment (pulsing dot + count); a flight parked on a checkpoint
// takes the amber "approval needed" treatment (that's the state that needs the
// human). Clicking opens a picker listing every flight with a per-stage mini
// rail; selecting one opens the routed flight detail view.

export const FLIGHT_STATUS_TONE: Record<FlightStatus, string> = {
  'running': 'rgb(56, 189, 248)',
  'waiting-for-approval': 'rgb(251, 191, 36)',
  'paused': 'rgb(251, 191, 36)',
  'done': 'rgb(52, 211, 153)',
  'failed': 'var(--danger)',
  'aborted': 'var(--text-muted)',
}

export function flightStatusLabel(status: FlightStatus): string {
  if (status === 'waiting-for-approval') return 'needs approval'
  return status
}

function statusRank(status: FlightStatus): number {
  // Worst-first: the flight that needs a human floats to the top.
  if (status === 'waiting-for-approval') return 0
  if (status === 'running') return 1
  if (status === 'paused') return 2
  if (status === 'failed') return 3
  if (status === 'aborted') return 4
  return 5 // done
}

export function FlightsPill({
  flights,
  onOpenFlight,
}: {
  flights: FlightIndexEntry[]
  onOpenFlight: (flightId: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const active = flights.filter((f) => f.status === 'running' || f.status === 'waiting-for-approval')
  const waiting = flights.filter((f) => f.status === 'waiting-for-approval')

  const tone = waiting.length > 0 ? FLIGHT_STATUS_TONE['waiting-for-approval'] : active.length > 0 ? 'var(--accent)' : undefined
  const label = waiting.length > 0
    ? `Flights · approval needed`
    : active.length > 0
      ? `Flights · ${active.length} active`
      : 'Flights'

  return (
    <div className="shrink-0" data-testid="flights-pill">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label="Flights"
        title={active.length
          ? active.map((f) => `${f.feature}: ${f.currentStage ?? '?'} (${flightStatusLabel(f.status)})`).join('\n')
          : 'First Flight — one command from bare repo to evaluated run'}
        className="cl-button flex items-center gap-1.5 px-2.5 py-1"
        style={tone ? { color: tone, borderColor: `color-mix(in srgb, ${tone} 45%, var(--border-default))` } : undefined}
      >
        {active.length > 0 ? (
          <StatusDot state="running" className="shrink-0" />
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
            <path d="M22 2 11 13" />
            <path d="M22 2 15 22l-4-9-9-4Z" />
          </svg>
        )}
        <span style={{ fontSize: 12, fontWeight: 500, color: tone }}>{label}</span>
        {active.length > 0 && (
          <span
            data-testid="flights-pill-count"
            className="rounded px-1 text-[10px] font-semibold"
            style={{ background: `color-mix(in srgb, ${tone ?? 'var(--accent)'} 18%, transparent)`, color: tone }}
          >
            {active.length}
          </span>
        )}
      </button>
      {open && (
        <FlightsPickerDialog
          flights={flights}
          onPick={(id) => { setOpen(false); onOpenFlight(id) }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

/** Eleven tiny cells, one per stage, colored by stage status — the at-a-glance
 *  progress rail used in the picker rows and the flights landing list. */
export function StageMiniRail({ stages }: { stages: Array<{ key: string; status: FlightStageStatus }> }) {
  const byKey = new Map(stages.map((s) => [s.key, s.status]))
  const toneFor = (status: FlightStageStatus | undefined): string => {
    if (status === 'done') return 'rgb(52, 211, 153)'
    if (status === 'running') return 'rgb(56, 189, 248)'
    if (status === 'waiting-for-approval') return 'rgb(251, 191, 36)'
    if (status === 'failed') return 'var(--danger)'
    if (status === 'skipped') return 'color-mix(in srgb, rgb(52, 211, 153) 40%, transparent)'
    return 'var(--border-default)'
  }
  return (
    <span className="inline-flex items-center gap-[3px]" data-testid="stage-mini-rail" aria-hidden="true">
      {FLIGHT_STAGE_KEYS.map((key) => (
        <span
          key={key}
          title={`${key}: ${byKey.get(key) ?? 'pending'}`}
          className="inline-block h-[8px] w-[8px] rounded-[2px]"
          style={{ background: toneFor(byKey.get(key)) }}
        />
      ))}
    </span>
  )
}

function FlightsPickerDialog({
  flights,
  onPick,
  onClose,
}: {
  flights: FlightIndexEntry[]
  onPick: (flightId: string | null) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const sorted = [...flights].sort((a, b) =>
    statusRank(a.status) - statusRank(b.status) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))

  // Portalled to <body>: the status-bar action cluster is overflow-hidden and
  // carries a transform during its collapse animation.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-end bg-black/30 p-6" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Open flights"
        data-testid="flights-task-menu"
        className="flex max-h-[calc(100vh-3rem)] w-[min(560px,calc(100vw-3rem))] flex-col rounded-lg border shadow-2xl"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cl-dialog-header">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">🕊️ First Flights</h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              One command from a bare repo to a green, covered, evaluated run. Pick a flight to follow its stages and answer checkpoints.
            </p>
          </div>
          <button type="button" aria-label="Close flights picker" onClick={onClose} className="rounded px-2 py-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            Close
          </button>
        </header>

        {flights.length === 0 ? (
          <div className="px-4 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            No flights yet. Start one from a terminal:
            <div className="mt-2 rounded px-2 py-1.5 text-[11px]" style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-base)', border: '1px solid var(--border-default)' }}>
              npx canary-lab fly ../your-repo "what to test"
            </div>
          </div>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2 scrollbar-thin">
            {sorted.map((f) => (
              <li key={f.flightId}>
                <button
                  type="button"
                  data-testid={`flight-open-${f.flightId}`}
                  onClick={() => onPick(f.flightId)}
                  className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
                  style={{ border: '1px solid var(--border-default)' }}
                  title={`Open flight ${f.flightId} (${f.feature})`}
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{f.feature}</span>
                  <StageMiniRail stages={f.stages ?? []} />
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                    style={{
                      color: FLIGHT_STATUS_TONE[f.status],
                      border: `1px solid color-mix(in srgb, ${FLIGHT_STATUS_TONE[f.status]} 35%, transparent)`,
                    }}
                  >
                    {f.status === 'running' && f.currentStage ? f.currentStage : flightStatusLabel(f.status)}
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>→</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <footer className="border-t px-4 py-2.5 text-[10.5px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
          Every stage verdict is computed by canary (boot passed, coverage met, run green) — the agent only proposes.
        </footer>
      </section>
    </div>,
    document.body,
  )
}
