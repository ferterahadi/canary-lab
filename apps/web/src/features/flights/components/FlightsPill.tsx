import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FlightIndexEntry, FlightStageStatus, FlightStatus } from '../../../shared/api/client'
import { StatusDot } from '../../config/components/atoms'
import { FLIGHT_STAGE_KEYS } from '../../../../../../shared/flights/types'
import type { FeatureActivity, FeatureActivityKind } from '../state/feature-activity'
import { stageLabel, stageRailRows, stageStatusTone } from './stage-meta'

// Flights pill — an always-visible launcher for Flight (`canary-lab flight`)
// progress, and (since the pill consolidation) the one live indicator for
// per-feature activity: a flight, a standalone test run, a portify job, or an
// authoring draft all light it up. Idle it's a neutral launcher; while
// anything is happening it takes the in-flight treatment (pulsing dot +
// count); a flight parked on a checkpoint takes the amber "approval needed"
// treatment (that's the state that needs the human). Clicking opens a picker
// listing every flight — and any feature with live activity but no flight —
// with a per-stage mini rail; selecting a row opens the routed flight detail
// view (or the activity's real surface: run detail / portify workflow /
// wizard draft).

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

/** Chip verb + tooltip per live activity kind (sky = in progress, same hue as
 *  a running flight — the colour means the same thing everywhere). */
const ACTIVITY_CHIP: Record<FeatureActivityKind, { label: string; title: string }> = {
  'running': { label: 'running', title: 'Test run in progress' },
  'portifying': { label: 'portifying', title: 'Port-ification in progress' },
  'authoring': { label: 'authoring', title: 'Authoring test specs' },
}

export interface FeatureChipState {
  /** Visible chip text — short labels only, the column is fixed-width. */
  label: string
  tone: string
  /** True while something is actively happening (drives live treatments). */
  live: boolean
  /** Worst-first sort rank for rows (0 = needs the human most). */
  rank: number
  /** Tooltip detail — the fuller story the fixed-width chip can't carry. */
  title: string
}

/**
 * THE state precedence for a feature's chip (picker + landing rows) — the
 * single place the "what does the chip say right now" transition lives:
 *
 *   1. flight parked on a checkpoint → "to approve"  (amber — the human is the
 *      blocker; outranks live activity because nothing moves until they act)
 *   2. live activity on the feature  → "running" / "portifying" / "authoring"
 *      (sky — narrates the absorbed surfaces (runs / portify / wizard drafts)
 *      whether the job was started by a flight stage or standalone)
 *   3. flight conductor active       → "running"     (sky — between stage jobs)
 *   4. flight paused                 → "paused"      (amber)
 *   5. nothing happening             → the LAST state: "done" / "failed" / "aborted"
 */
export function featureChipState(
  flight: Pick<FlightIndexEntry, 'status' | 'currentStage'> | null,
  activity?: FeatureActivity,
): FeatureChipState {
  if (flight?.status === 'waiting-for-approval') {
    return { label: 'to approve', tone: FLIGHT_STATUS_TONE['waiting-for-approval'], live: false, rank: 0, title: 'needs approval' }
  }
  if (activity) {
    const chip = ACTIVITY_CHIP[activity.kind]
    return { label: chip.label, tone: FLIGHT_STATUS_TONE['running'], live: true, rank: 1, title: chip.title }
  }
  if (!flight) {
    // Unreachable by the render rule (a row exists only with a flight or an
    // activity) — kept total so the function can't throw on a race.
    return { label: '—', tone: 'var(--text-muted)', live: false, rank: 6, title: 'no activity' }
  }
  if (flight.status === 'running') {
    return {
      label: 'running',
      tone: FLIGHT_STATUS_TONE['running'],
      live: true,
      rank: 1,
      title: flight.currentStage ? stageLabel(flight.currentStage) : 'running',
    }
  }
  const rank = flight.status === 'paused' ? 2 : flight.status === 'failed' ? 3 : flight.status === 'aborted' ? 4 : 5
  return { label: flight.status, tone: FLIGHT_STATUS_TONE[flight.status], live: false, rank, title: flightStatusLabel(flight.status) }
}

/** Fixed-width status chip for a feature row (landing list + picker): pinned
 *  to the widest labels ("to approve" / "portifying") so the mini-rail and
 *  chip stay aligned across rows, and a row doesn't jump sideways as its
 *  state changes. The fuller story only reaches the tooltip, never the
 *  visible text, so it can't widen the column. */
export function FlightStatusChip({
  flight,
  activity,
}: {
  flight: Pick<FlightIndexEntry, 'status' | 'currentStage'> | null
  activity?: FeatureActivity
}) {
  const chip = featureChipState(flight, activity)
  return (
    <span
      data-testid="flight-status-chip"
      title={chip.title}
      className="inline-flex w-[72px] shrink-0 items-center justify-center overflow-hidden text-ellipsis whitespace-nowrap rounded px-1.5 py-0.5 text-center text-[10.5px] font-medium"
      style={{ color: chip.tone, border: `1px solid color-mix(in srgb, ${chip.tone} 35%, transparent)` }}
    >
      {chip.label}
    </span>
  )
}

/** One unified row model for the picker/landing lists: every feature with a
 *  flight record, plus every feature with live activity but no flight yet. */
export interface FeatureActivityRow {
  feature: string
  flight: FlightIndexEntry | null
  activity?: FeatureActivity
}

/** Merge flights + the activity map into rows, worst-first (the row that
 *  needs the human floats to the top; live rows above resting ones). */
export function featureActivityRows(
  flights: FlightIndexEntry[],
  activity: Map<string, FeatureActivity>,
): FeatureActivityRow[] {
  const rows: FeatureActivityRow[] = flights.map((f) => ({ feature: f.feature, flight: f, activity: activity.get(f.feature) }))
  for (const [feature, act] of activity) {
    if (!flights.some((f) => f.feature === feature)) rows.push({ feature, flight: null, activity: act })
  }
  return rows.sort((a, b) =>
    featureChipState(a.flight, a.activity).rank - featureChipState(b.flight, b.activity).rank
    || (b.flight?.updatedAt ?? '').localeCompare(a.flight?.updatedAt ?? ''))
}

export function FlightsPill({
  flights,
  activity = new Map(),
  onOpenFlight,
  onOpenActivity,
}: {
  flights: FlightIndexEntry[]
  /** Per-feature live activity (runs / portify / authoring) from useFeatureActivity — App owns it. */
  activity?: Map<string, FeatureActivity>
  onOpenFlight: (flightId: string | null) => void
  /** Open the real surface behind an activity-only row (no flight record). */
  onOpenActivity?: (feature: string, activity: FeatureActivity) => void
}) {
  const [open, setOpen] = useState(false)
  const waiting = flights.filter((f) => f.status === 'waiting-for-approval')
  // Everything alive right now, deduped by feature: active flights AND live
  // activity on the absorbed surfaces (a flight's run stage and its run count
  // once, not twice).
  const attention = new Set<string>([
    ...flights.filter((f) => f.status === 'running' || f.status === 'waiting-for-approval').map((f) => f.feature),
    ...activity.keys(),
  ])
  const activeCount = attention.size

  const tone = waiting.length > 0 ? FLIGHT_STATUS_TONE['waiting-for-approval'] : activeCount > 0 ? 'var(--accent)' : undefined
  const label = waiting.length > 0
    ? `Flights · approval needed`
    : activeCount > 0
      ? `Flights · ${activeCount} active`
      : 'Flights'

  const tooltip = activeCount > 0
    ? featureActivityRows(flights, activity)
        .filter((r) => attention.has(r.feature))
        .map((r) => `${r.feature}: ${featureChipState(r.flight, r.activity).title}`)
        .join('\n')
    : 'Flight — one command from bare repo to evaluated run'

  return (
    <div className="shrink-0" data-testid="flights-pill">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label="Flights"
        title={tooltip}
        className="cl-button flex items-center gap-1.5 px-2.5 py-1"
        style={tone ? { color: tone, borderColor: `color-mix(in srgb, ${tone} 45%, var(--border-default))` } : undefined}
      >
        {activeCount > 0 ? (
          <StatusDot state="running" className="shrink-0" />
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
            <path d="M22 2 11 13" />
            <path d="M22 2 15 22l-4-9-9-4Z" />
          </svg>
        )}
        <span style={{ fontSize: 12, fontWeight: 500, color: tone }}>{label}</span>
        {activeCount > 0 && (
          <span
            data-testid="flights-pill-count"
            className="rounded px-1 text-[10px] font-semibold"
            style={{ background: `color-mix(in srgb, ${tone ?? 'var(--accent)'} 18%, transparent)`, color: tone }}
          >
            {activeCount}
          </span>
        )}
      </button>
      {open && (
        <FlightsPickerDialog
          flights={flights}
          activity={activity}
          onPick={(id) => { setOpen(false); onOpenFlight(id) }}
          onPickActivity={(feature, act) => { setOpen(false); onOpenActivity?.(feature, act) }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

/** One tiny cell per USER-VISIBLE stage (same rows as the flight detail rail —
 *  similarity hidden unless it needs a human, run+heal merged), colored by
 *  status — the at-a-glance progress rail in the picker rows and landing list. */
export function StageMiniRail({ stages }: { stages: Array<{ key: string; status: FlightStageStatus }> }) {
  const source = stages.length > 0
    ? stages
    : FLIGHT_STAGE_KEYS.map((key) => ({ key: key as string, status: 'pending' as FlightStageStatus }))
  const toneFor = (status: FlightStageStatus): string => {
    if (status === 'pending') return 'var(--border-default)'
    if (status === 'skipped') return 'color-mix(in srgb, rgb(52, 211, 153) 40%, transparent)'
    return stageStatusTone(status)
  }
  return (
    <span className="inline-flex items-center gap-[3px]" data-testid="stage-mini-rail" aria-hidden="true">
      {stageRailRows(source).map((row) => (
        <span
          key={row.key}
          title={`${row.label}: ${row.status}`}
          className="inline-block h-[8px] w-[8px] rounded-[2px]"
          style={{ background: toneFor(row.status) }}
        />
      ))}
    </span>
  )
}

function FlightsPickerDialog({
  flights,
  activity,
  onPick,
  onPickActivity,
  onClose,
}: {
  flights: FlightIndexEntry[]
  activity: Map<string, FeatureActivity>
  onPick: (flightId: string | null) => void
  onPickActivity: (feature: string, activity: FeatureActivity) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = featureActivityRows(flights, activity)

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
            <h2 className="text-sm font-semibold">🕊️ Flights</h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              One command from a bare repo to a green, covered, evaluated run. Pick a flight to follow its stages and answer checkpoints.
            </p>
          </div>
          <button type="button" aria-label="Close flights picker" onClick={onClose} className="rounded px-2 py-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            Close
          </button>
        </header>

        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            No flights yet. Start one from a terminal:
            <div className="mt-2 rounded px-2 py-1.5 text-[11px]" style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-base)', border: '1px solid var(--border-default)' }}>
              npx canary-lab flight ../your-repo "what to test"
            </div>
          </div>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2 scrollbar-thin">
            {rows.map((row) => (
              <li key={row.flight?.flightId ?? `activity-${row.feature}`}>
                {row.flight ? (
                  <button
                    type="button"
                    data-testid={`flight-open-${row.flight.flightId}`}
                    onClick={() => onPick(row.flight!.flightId)}
                    className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
                    style={{ border: '1px solid var(--border-default)' }}
                    title={`Open flight ${row.flight.flightId} (${row.feature})`}
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{row.feature}</span>
                    <StageMiniRail stages={row.flight.stages ?? []} />
                    <FlightStatusChip flight={row.flight} activity={row.activity} />
                    <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>→</span>
                  </button>
                ) : (
                  <ActivityOnlyRow feature={row.feature} activity={row.activity!} onOpen={onPickActivity} />
                )}
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

/** Row for a feature with live activity but no flight record (a standalone
 *  run / portify / authoring job): same shape as a flight row, "no flight" in
 *  the mini-rail slot, and clicking opens the activity's REAL surface. */
export function ActivityOnlyRow({
  feature,
  activity,
  onOpen,
}: {
  feature: string
  activity: FeatureActivity
  onOpen: (feature: string, activity: FeatureActivity) => void
}) {
  return (
    <button
      type="button"
      data-testid={`activity-open-${feature}`}
      onClick={() => onOpen(feature, activity)}
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
      style={{ border: '1px solid var(--border-default)' }}
      title={`${feature}: ${ACTIVITY_CHIP[activity.kind].title}`}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{feature}</span>
      <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>no flight</span>
      <FlightStatusChip flight={null} activity={activity} />
      <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>→</span>
    </button>
  )
}
