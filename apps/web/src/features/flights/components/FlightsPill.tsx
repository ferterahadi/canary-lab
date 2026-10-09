import { useControlledBoolean } from '@/shared/state/use-controlled-boolean'
import { flightNeedsAttention } from '@shared/flights/attention'
import { useWorkspaceActions } from '@/shared/state/workspace-actions'
import { useWorkState } from '@/shared/state/work-state'
import { StatusPill } from '@/shared/ui/StatusPill'
import { FLIGHT_STATUS_TONE, featureActivityRows, featureChipState, preFlightChipState, summarizeFlightActivity } from './FlightChipState'
import { FlightsPickerDialog } from './FlightPickerRows'
import { flightAwaitsUser } from '../lib/external-work'
import { FLIGHT_OVERVIEW } from './stage-meta'
import { PlaneIcon } from '@/shared/ui/Icons'

export interface FlightsPillProps {
  /** Controlled/uncontrolled hybrid (cl_route-every-surface): App drives the
   *  picker's open-state off the route (`view=flights` + no flight selected) so
   *  it's the same deep-linkable surface the URL addresses. Absent → the pill
   *  falls back to its own state (keeps this component's unit tests standalone). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

// The pill reads the workspace's live work (flights, pre-flights, activity,
// coverage jobs, Portify workflows, and the picker's suite rows — R49, grouped
// per R55) from WorkState, and its destinations from WorkspaceActions. An
// absent action leaves its row inert, as an omitted prop did.
export function FlightsPill({ open: controlledOpen, onOpenChange }: FlightsPillProps) {
  const {
    flights = [],
    preFlights = [],
    activity = new Map(),
    pickerFeatures: features = [],
    coverageJobs = [],
    portifyWorkflows = [],
  } = useWorkState()
  const { openFlight, openActivity, startFlight, openPreFlight } = useWorkspaceActions()
  const [open, setOpen] = useControlledBoolean(controlledOpen, onOpenChange)
  // Defensive: the server list is already scoped to running/done, but a stale
  // frame shouldn't render launched/failed rows.
  const { activeFeatures: attention, preFlightRows, activeCount } = summarizeFlightActivity(flights, preFlights, activity)
  const preFlightReview = preFlightRows.filter((t) => t.status === 'done')
  // A flight parked on an external-work hand-off is BUSY, not blocked — the
  // step is running in the user's own agent. It keeps its place in the active
  // count below, but must never turn the pill amber or claim approval is
  // needed, because there is nothing here for the reader to approve.
  const waiting = flights.filter(flightAwaitsUser)
  // Everything alive right now, deduped by feature: active flights AND live
  // activity on the absorbed surfaces (a flight's run stage and its run count
  // once, not twice).
  // Pre-flights are pre-feature (no feature key yet) — they add to the count
  // on their own, above the feature rows.

  // R68: a persistent amber dot on the trigger whenever the human is the
  // blocker — a flight parked on a checkpoint / paused for a non-user,
  // non-queued reason, OR a pre-flight settled and awaiting review. Independent
  // of any toast — it stays until the underlying state resolves.
  const waitingForReview = [...activity.values()].some((a) => a.waiting?.kind === 'test-review')
  const needsAttention = waitingForReview || preFlightReview.length > 0 || flights.some(flightNeedsAttention)

  const needsHuman = waitingForReview || waiting.length > 0 || preFlightReview.length > 0
  const tone = needsHuman ? FLIGHT_STATUS_TONE['waiting-for-approval'] : activeCount > 0 ? 'var(--accent)' : undefined
  const label = waitingForReview
    ? 'Flights · review needed'
    : needsHuman
    ? `Flights · approval needed`
    : activeCount > 0
      ? `Flights · ${activeCount} active`
      : 'Flights'

  const tooltip = activeCount > 0
    ? [
        ...preFlightRows.map((t) => `planning: ${preFlightChipState(t).title}`),
        ...featureActivityRows(flights, activity)
          .filter((r) => attention.has(r.feature))
          .map((r) => `${r.feature}: ${featureChipState(r.flight, r.activity).title}`),
      ].join('\n')
    // The picker's own tagline, verbatim — the pill and the panel it opens must
    // not describe the same thing in two different sentences.
    : FLIGHT_OVERVIEW

  return (
    <div className="shrink-0" data-testid="flights-pill">
      <StatusPill
        dotState="running"
        icon={activeCount > 0 ? undefined : (
          <PlaneIcon className="shrink-0" />
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
          coverageJobs={coverageJobs}
          portifyWorkflows={portifyWorkflows}
          onPick={(id, stage) => { setOpen(false); if (stage) openFlight?.(id, stage); else openFlight?.(id) }}
          onPickActivity={(feature, act) => { setOpen(false); openActivity?.(feature, act) }}
          onStartFlight={(feature) => { setOpen(false); startFlight?.(feature) }}
          onPickPreFlight={(taskId) => { setOpen(false); openPreFlight?.(taskId) }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
