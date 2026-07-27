import { useState } from 'react'
import type { FlightIndexEntry, FlightStageKey, FlightStageStatus, PlanFeaturesTask } from '@/shared/api/client'
import type { FeatureActivity } from '../state/feature-activity'
import { StatusPill } from '@/shared/ui/StatusPill'
import { FLIGHT_STATUS_TONE, featureActivityRows, featureChipState, preFlightChipState } from './FlightChipState'
import { FlightsPickerDialog } from './FlightPickerRows'

export { FLIGHT_STATUS_TONE, FlightStatusChip, activityStages, featureActivityRows, featureChipState, flightStatusLabel, groupPickerRows, preFlightChipState } from './FlightChipState'
export type { FeatureActivityRow, FeatureChipState, FeatureRef, PickerGroup } from './FlightChipState'
export { ActivityOnlyRow, NotFlownRow, PreFlightRow, StageMiniRail } from './FlightPickerRows'

export function FlightsPill({
  flights,
  preFlights = [],
  activity = new Map(),
  features = [],
  open: controlledOpen,
  onOpenChange,
  onOpenFlight,
  onOpenActivity,
  onStartFlight,
  onOpenPreFlight,
}: {
  flights: FlightIndexEntry[]
  /** Pre-flight (plan-features) tasks in progress / awaiting review — rendered
   *  as their own rows above the feature rows (they precede any feature). */
  preFlights?: PlanFeaturesTask[]
  /** Per-feature live activity (runs / portify / authoring) from useFeatureActivity — App owns it. */
  activity?: Map<string, FeatureActivity>
  /** Every workspace feature — the picker lists them 1:1 (R49) and groups those
   *  that declare a `group` under a disclosure (R55). `stages` is the feature's
   *  evidence-derived rail (derived-stages.ts) for flightless rows. */
  features?: Array<{ name: string; group?: string; stages?: Array<{ key: FlightStageKey; status: FlightStageStatus }> }>
  /** Controlled/uncontrolled hybrid (cl_route-every-surface): App drives the
   *  picker's open-state off the route (`view=flights` + no flight selected) so
   *  it's the same deep-linkable surface the URL addresses. Absent → the pill
   *  falls back to its own state (keeps this component's unit tests standalone). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onOpenFlight: (flightId: string | null) => void
  /** Open the real surface behind an activity-only row (no flight record). */
  onOpenActivity?: (feature: string, activity: FeatureActivity) => void
  /** Open the flight launcher for a never-flown feature (R49). */
  onStartFlight?: (feature: string) => void
  /** Reopen the new-flight dialog attached to a running/awaiting pre-flight. */
  onOpenPreFlight?: (taskId: string) => void
}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = (next: boolean): void => {
    if (onOpenChange) onOpenChange(next)
    else setInternalOpen(next)
  }
  // Defensive: the server list is already scoped to running/done, but a stale
  // frame shouldn't render launched/failed rows.
  const preFlightRows = preFlights.filter((t) => t.status === 'running' || t.status === 'done')
  const preFlightReview = preFlightRows.filter((t) => t.status === 'done')
  const waiting = flights.filter((f) => f.status === 'waiting-for-approval')
  // Everything alive right now, deduped by feature: active flights AND live
  // activity on the absorbed surfaces (a flight's run stage and its run count
  // once, not twice).
  const attention = new Set<string>([
    ...flights.filter((f) => f.status === 'running' || f.status === 'waiting-for-approval').map((f) => f.feature),
    ...activity.keys(),
  ])
  // Pre-flights are pre-feature (no feature key yet) — they add to the count
  // on their own, above the feature rows.
  const activeCount = attention.size + preFlightRows.length

  // R68: a persistent amber dot on the trigger whenever the human is the
  // blocker — a flight parked on a checkpoint / paused for a non-user,
  // non-queued reason, OR a pre-flight settled and awaiting review. Independent
  // of any toast — it stays until the underlying state resolves.
  const needsAttention = preFlightReview.length > 0 || flights.some((f) =>
    f.status === 'waiting-for-approval'
    || (f.status === 'paused' && f.pauseReason !== 'user' && f.pauseReason !== 'queued'))

  const needsHuman = waiting.length > 0 || preFlightReview.length > 0
  const tone = needsHuman ? FLIGHT_STATUS_TONE['waiting-for-approval'] : activeCount > 0 ? 'var(--accent)' : undefined
  const label = needsHuman
    ? `Flights · approval needed`
    : activeCount > 0
      ? `Flights · ${activeCount} active`
      : 'Flights'

  const tooltip = activeCount > 0
    ? [
        ...preFlightRows.map((t) => `pre-flight: ${preFlightChipState(t).title}`),
        ...featureActivityRows(flights, activity)
          .filter((r) => attention.has(r.feature))
          .map((r) => `${r.feature}: ${featureChipState(r.flight, r.activity).title}`),
      ].join('\n')
    : 'Flight — one command from bare repo to evaluated run'

  return (
    <div className="shrink-0" data-testid="flights-pill">
      <StatusPill
        dotState="running"
        icon={activeCount > 0 ? undefined : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
            <path d="M22 2 11 13" />
            <path d="M22 2 15 22l-4-9-9-4Z" />
          </svg>
        )}
        name={label}
        count={activeCount > 0 ? activeCount : undefined}
        countColor={tone}
        countTestId="flights-pill-count"
        emphasis={Boolean(tone)}
        emphasisColor={tone}
        overlayDot={needsAttention}
        ariaExpanded={open}
        ariaLabel="Flights"
        title={tooltip}
        onClick={() => setOpen(true)}
      />
      {open && (
        <FlightsPickerDialog
          flights={flights}
          preFlights={preFlightRows}
          activity={activity}
          features={features}
          onPick={(id) => { setOpen(false); onOpenFlight(id) }}
          onPickActivity={(feature, act) => { setOpen(false); onOpenActivity?.(feature, act) }}
          onStartFlight={(feature) => { setOpen(false); onStartFlight?.(feature) }}
          onPickPreFlight={(taskId) => { setOpen(false); onOpenPreFlight?.(taskId) }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
