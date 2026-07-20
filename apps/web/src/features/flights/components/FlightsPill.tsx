import { useState } from 'react'
import type { FlightIndexEntry, FlightPauseReason, FlightStageKey, FlightStageStatus, FlightStatus, PlanFeaturesTask } from '../../../shared/api/client'
import { ChevronRightIcon, SlideOverPanel } from '../../config/components/atoms'
import { FLIGHT_STAGE_KEYS } from '../../../../../../shared/flights/types'
import type { FeatureActivity, FeatureActivityKind } from '../state/feature-activity'
import { Chip } from '../../../shared/ui/StatusChip'
import { StatusPill } from '../../../shared/ui/StatusPill'
import { Tooltip } from '../../../shared/ui/Tooltip'
import { stageLabel, stageRailRows, stageStatusTone } from './stage-meta'
import { readGroupOpen, writeGroupOpen } from '../lib/group-open-state'

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

/** Chip state for a pre-flight (plan-features) row — the intent breakdown that
 *  runs BEFORE any feature/flight exists. `running` = the agent is judging one
 *  feature or several (sky, live); `done` = it settled and needs the human
 *  (amber "to review": confirm a multi-feature split, or rename a single
 *  feature whose name clashed). Ranks between a flight checkpoint (0) and a
 *  running flight (1) — a pending proposal is waiting on the human. */
export function preFlightChipState(
  task: Pick<PlanFeaturesTask, 'status' | 'conflicts'>,
): { label: string; tone: string; live: boolean; rank: number; title: string } {
  if (task.status === 'running') {
    return { label: 'planning', tone: FLIGHT_STATUS_TONE['running'], live: true, rank: 1, title: 'Judging whether this intent is one feature or several' }
  }
  const conflict = (task.conflicts?.length ?? 0) > 0
  return {
    label: 'to review',
    tone: FLIGHT_STATUS_TONE['waiting-for-approval'],
    live: false,
    rank: 0.5,
    title: conflict ? 'Name already in use — reopen to rename and launch' : 'Proposal ready — reopen to confirm the split',
  }
}

/** Chip verb + tooltip per live activity kind (sky = in progress, same hue as
 *  a running flight — the colour means the same thing everywhere). */
const ACTIVITY_CHIP: Record<FeatureActivityKind, { label: string; title: string }> = {
  'running': { label: 'running', title: 'Test run in progress' },
  'exporting': { label: 'exporting', title: 'Evaluation export in progress' },
  'portifying': { label: 'portifying', title: 'Port-ification in progress' },
  'authoring': { label: 'authoring', title: 'Authoring test specs' },
}

/** Short chip verb for a RUNNING flight, keyed by the stage the conductor is
 *  on — the chip narrates WHAT is happening rather than a flat "running" (and
 *  reads the same as the standalone ACTIVITY_CHIP verb for the absorbed
 *  surface: a flight authoring specs and a standalone authoring draft both say
 *  "authoring"). Unmapped stages keep the generic "running". */
const RUNNING_STAGE_CHIP: Partial<Record<FlightStageKey, string>> = {
  'specs-coverage': 'authoring',
}

/** Which flight stage a standalone activity kind maps onto — so an
 *  activity-only row (no flight record) can still show WHERE in the pipeline
 *  the live job sits (R56). */
const ACTIVITY_STAGE: Record<FeatureActivityKind, FlightStageKey> = {
  'authoring': 'specs-coverage',
  'exporting': 'evaluation-export',
  'portifying': 'portify',
  'running': 'run',
}

/** Synthesize a per-stage array for an activity-only row: the mapped stage is
 *  'running' (renders the sky-blue "current" tone) over the feature's
 *  evidence-derived rail when one exists (completed steps stay lit), else over
 *  all-pending. Honest — no fake 'done' squares for stages with no artifact. */
export function activityStages(
  kind: FeatureActivityKind,
  base?: Array<{ key: FlightStageKey; status: FlightStageStatus }>,
): Array<{ key: FlightStageKey; status: FlightStageStatus }> {
  const current = ACTIVITY_STAGE[kind]
  const baseFor = new Map((base ?? []).map((s) => [s.key, s.status]))
  return FLIGHT_STAGE_KEYS.map((key) => ({
    key,
    status: (key === current ? 'running' : baseFor.get(key) ?? 'pending') as FlightStageStatus,
  }))
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
 *   3. flight conductor active       → the stage verb (sky — "authoring" on
 *      specs-coverage, else the generic "running" between/on other stages)
 *   4. flight paused                 → "paused"      (amber)
 *   5. nothing happening             → the LAST state: "done" / "failed" / "aborted"
 *
 *  A `queued` sibling (paused with pauseReason 'queued' — parked by a
 *  plan-features launch, auto-started by the conductor) is NOT an attention
 *  state: it reads muted/neutral ("queued") and ranks just above never-flown,
 *  since nothing is asked of the human.
 *
 *  A flightless feature splits on evidence: standalone progress exists (any
 *  lit square in its derived rail) → "idle" — the chip stays a flight-status
 *  reporter, it never re-narrates what the squares already show; zero
 *  evidence (or an older server without the evidence payload) → "not flown".
 */
export function featureChipState(
  flight: Pick<FlightIndexEntry, 'status' | 'currentStage' | 'pauseReason'> | null,
  activity?: FeatureActivity,
  derived?: Array<{ key: FlightStageKey; status: FlightStageStatus }>,
): FeatureChipState {
  if (flight?.status === 'waiting-for-approval') {
    return { label: 'to approve', tone: FLIGHT_STATUS_TONE['waiting-for-approval'], live: false, rank: 0, title: 'needs approval' }
  }
  // A queued sibling needs no attention — muted, and it sinks below every
  // resting state (only never-flown ranks lower). Checked before live activity
  // isn't needed (a queued flight has no live job of its own), but before the
  // generic paused branch it must be.
  if (flight?.status === 'paused' && flight.pauseReason === 'queued') {
    return { label: 'queued', tone: 'var(--text-muted)', live: false, rank: 5.5, title: 'queued — starts automatically when the repo is free' }
  }
  if (activity) {
    const chip = ACTIVITY_CHIP[activity.kind]
    return { label: chip.label, tone: FLIGHT_STATUS_TONE['running'], live: true, rank: 1, title: chip.title }
  }
  if (!flight) {
    // R49: one row per workspace feature, at the bottom; clicking it opens the
    // flight launcher. "idle" when standalone work already lit squares (the
    // rail carries the progress story); "not flown" only when truly untouched.
    if (derived?.some((s) => s.status !== 'pending')) {
      return { label: 'idle', tone: 'var(--text-secondary)', live: false, rank: 5.8, title: 'progress from standalone work — start a flight to conduct it end-to-end' }
    }
    return { label: 'not flown', tone: 'var(--text-muted)', live: false, rank: 6, title: 'never flown — start a flight' }
  }
  if (flight.status === 'running') {
    return {
      label: (flight.currentStage && RUNNING_STAGE_CHIP[flight.currentStage]) ?? 'running',
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
  derived,
}: {
  flight: Pick<FlightIndexEntry, 'status' | 'currentStage' | 'pauseReason'> | null
  activity?: FeatureActivity
  derived?: Array<{ key: FlightStageKey; status: FlightStageStatus }>
}) {
  const chip = featureChipState(flight, activity, derived)
  return (
    <Chip testId="flight-status-chip" chrome="border" tone={chip.tone} label={chip.label} width={72} title={chip.title} />
  )
}

/** One unified row model for the picker/landing lists: every feature with a
 *  flight record, plus every feature with live activity but no flight yet. */
export interface FeatureActivityRow {
  feature: string
  flight: FlightIndexEntry | null
  activity?: FeatureActivity
  /** Evidence-derived rail for a flightless feature (see derived-stages.ts) —
   *  what standalone work already completed. Rows with a flight record ignore
   *  it (the record is the journal). */
  derived?: Array<{ key: FlightStageKey; status: FlightStageStatus }>
}

/** A workspace feature the picker/landing lists know about — a bare name, or a
 *  name + optional group and evidence-derived stages (R55). Both call sites
 *  pass whatever they have; the row builder normalizes. */
export type FeatureRef = string | { name: string; group?: string; stages?: Array<{ key: FlightStageKey; status: FlightStageStatus }> }

function featureName(f: FeatureRef): string {
  return typeof f === 'string' ? f : f.name
}

function featureStages(f: FeatureRef | undefined): Array<{ key: FlightStageKey; status: FlightStageStatus }> | undefined {
  return typeof f === 'object' ? f.stages : undefined
}

/** Merge flights + the activity map + the workspace feature list into rows,
 *  worst-first (the row that needs the human floats to the top; live rows
 *  above resting ones; never-flown features sink to the bottom, 1:1 — every
 *  feature has exactly one row, R49).
 *
 *  Defensive: even if an old server hands back two flight records for the same
 *  feature, the client shows ONE row per feature — the first (newest, since the
 *  index arrives worst/most-recent first and the sort is stable per feature)
 *  wins. This keeps the 1:1 invariant against a stale server. */
export function featureActivityRows(
  flights: FlightIndexEntry[],
  activity: Map<string, FeatureActivity>,
  features: FeatureRef[] = [],
): FeatureActivityRow[] {
  const rows: FeatureActivityRow[] = []
  const seen = new Set<string>()
  const stagesByName = new Map(features.map((f) => [featureName(f), featureStages(f)]))
  for (const f of flights) {
    if (seen.has(f.feature)) continue // dedupe by feature — keep the first
    seen.add(f.feature)
    rows.push({ feature: f.feature, flight: f, activity: activity.get(f.feature) })
  }
  for (const [feature, act] of activity) {
    if (seen.has(feature)) continue
    seen.add(feature)
    rows.push({ feature, flight: null, activity: act, derived: stagesByName.get(feature) })
  }
  for (const f of features) {
    const name = featureName(f)
    if (seen.has(name)) continue
    seen.add(name)
    rows.push({ feature: name, flight: null, derived: featureStages(f) })
  }
  return rows.sort((a, b) =>
    featureChipState(a.flight, a.activity, a.derived).rank - featureChipState(b.flight, b.activity, b.derived).rank
    || (b.flight?.updatedAt ?? '').localeCompare(a.flight?.updatedAt ?? '')
    || a.feature.localeCompare(b.feature))
}

/** A picker section: ungrouped rows render flat at top level; grouped rows
 *  collapse under a disclosure. `null` group = the flat top-level bucket. */
export interface PickerGroup {
  group: string | null
  rows: FeatureActivityRow[]
  /** The worst (lowest) chip rank in the group — orders the sections. */
  worstRank: number
}

/** Split already-sorted rows into the flat bucket + one section per group
 *  (R55). Rows keep their global (worst-first) order within each section;
 *  sections order by their worst row's rank. `features` supplies the
 *  feature→group lookup (a flight/activity row has no group of its own). */
export function groupPickerRows(rows: FeatureActivityRow[], features: FeatureRef[]): {
  ungrouped: FeatureActivityRow[]
  groups: PickerGroup[]
} {
  const groupOf = new Map<string, string | undefined>()
  for (const f of features) {
    if (typeof f !== 'string') groupOf.set(f.name, f.group?.trim() || undefined)
  }
  const ungrouped: FeatureActivityRow[] = []
  const byGroup = new Map<string, FeatureActivityRow[]>()
  for (const row of rows) {
    // Prefer the workspace feature's group; fall back to the flight's own group
    // so a still-pre-scaffold feature (First-Flight batch, not yet in the
    // features list) still lands in its section instead of the flat bucket.
    const group = groupOf.get(row.feature) || row.flight?.group?.trim() || undefined
    if (!group) { ungrouped.push(row); continue }
    const bucket = byGroup.get(group) ?? []
    bucket.push(row)
    byGroup.set(group, bucket)
  }
  const groups: PickerGroup[] = [...byGroup.entries()].map(([group, groupRows]) => ({
    group,
    rows: groupRows,
    worstRank: Math.min(...groupRows.map((r) => featureChipState(r.flight, r.activity, r.derived).rank)),
  }))
  groups.sort((a, b) => a.worstRank - b.worstRank || a.group!.localeCompare(b.group!))
  return { ungrouped, groups }
}

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
    <span className="inline-flex items-center gap-[3px]" data-testid="stage-mini-rail">
      {stageRailRows(source).map((row) => (
        <Tooltip key={row.key} label={`${row.label} — ${row.status}`}>
          <span
            data-testid={`stage-mini-cell-${row.key}`}
            className="inline-block h-[8px] w-[8px] rounded-[2px]"
            style={{ background: toneFor(row.status) }}
          />
        </Tooltip>
      ))}
    </span>
  )
}

function FlightsPickerDialog({
  flights,
  preFlights,
  activity,
  features,
  onPick,
  onPickActivity,
  onStartFlight,
  onPickPreFlight,
  onClose,
}: {
  flights: FlightIndexEntry[]
  preFlights: PlanFeaturesTask[]
  activity: Map<string, FeatureActivity>
  features: Array<{ name: string; group?: string; stages?: Array<{ key: FlightStageKey; status: FlightStageStatus }> }>
  onPick: (flightId: string | null) => void
  onPickActivity: (feature: string, activity: FeatureActivity) => void
  onStartFlight: (feature: string) => void
  onPickPreFlight: (taskId: string) => void
  onClose: () => void
}) {
  const rows = featureActivityRows(flights, activity, features)
  // R55: split into the flat top-level bucket + collapsible group sections.
  const { ungrouped, groups } = groupPickerRows(rows, features)
  // Pre-flights precede any feature, so they sit above the feature rows —
  // sorted worst-first (a settled "to review" above a still-planning one).
  const preFlightRows = [...preFlights].sort((a, b) => preFlightChipState(a).rank - preFlightChipState(b).rank)

  // Portalled to <body>: the status-bar action cluster is overflow-hidden and
  // carries a transform during its collapse animation.
  return (
    <SlideOverPanel
      onClose={onClose}
      ariaLabel="Open flights"
      testId="flights-task-menu"
      portal
      header={
        <>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">🕊️ Flights</h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              One command from a bare repo to a green, covered, evaluated run. Pick a flight to follow its stages and answer checkpoints.
            </p>
          </div>
          <button type="button" aria-label="Close flights picker" onClick={onClose} className="rounded px-2 py-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            Close
          </button>
        </>
      }
      footer="Every stage verdict is computed by canary (boot passed, coverage met, run green) — the agent only proposes."
    >
      {rows.length === 0 && preFlightRows.length === 0 ? (
        <div className="px-4 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
          No flights yet. Start one from a terminal:
          <div className="mt-2 rounded px-2 py-1.5 text-[11px]" style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-base)', border: '1px solid var(--border-default)' }}>
            npx canary-lab flight ../your-repo "what to test"
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
          {preFlightRows.length > 0 && (
            <ul className="flex flex-col gap-1">
              {preFlightRows.map((task) => (
                <PreFlightRow key={task.taskId} task={task} onOpen={onPickPreFlight} />
              ))}
            </ul>
          )}
          {ungrouped.length > 0 && (
            <ul className="flex flex-col gap-1">
              {ungrouped.map((row) => (
                <PickerRow
                  key={row.flight?.flightId ?? `activity-${row.feature}`}
                  row={row}
                  onPick={onPick}
                  onPickActivity={onPickActivity}
                  onStartFlight={onStartFlight}
                />
              ))}
            </ul>
          )}
          {groups.map((section) => (
            <PickerGroupSection
              key={section.group!}
              section={section}
              onPick={onPick}
              onPickActivity={onPickActivity}
              onStartFlight={onStartFlight}
            />
          ))}
        </div>
      )}
    </SlideOverPanel>
  )
}

/** One picker row — a flight, an activity-only feature, or a never-flown one.
 *  Shared by the flat top-level list and the group sections (R55). */
function PickerRow({
  row,
  onPick,
  onPickActivity,
  onStartFlight,
}: {
  row: FeatureActivityRow
  onPick: (flightId: string | null) => void
  onPickActivity: (feature: string, activity: FeatureActivity) => void
  onStartFlight: (feature: string) => void
}) {
  if (row.flight) {
    return (
      <li>
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
      </li>
    )
  }
  return (
    <li>
      {row.activity
        ? <ActivityOnlyRow feature={row.feature} activity={row.activity} derived={row.derived} onOpen={onPickActivity} />
        : <NotFlownRow feature={row.feature} derived={row.derived} onStart={onStartFlight} />}
    </li>
  )
}

const GROUPS_OPEN_STORAGE_KEY = 'cl-flight-groups-open'

/** A collapsible group section (R55): chevron + group name + count + a tiny
 *  worst-state chip; rows render under the disclosure. Open-state persists per
 *  group in localStorage; the picker's resting default is COLLAPSED (the list
 *  can be long — the worst-state summary chip carries what each group needs
 *  without expanding it), and an explicit user toggle is remembered. */
function PickerGroupSection({
  section,
  onPick,
  onPickActivity,
  onStartFlight,
}: {
  section: PickerGroup
  onPick: (flightId: string | null) => void
  onPickActivity: (feature: string, activity: FeatureActivity) => void
  onStartFlight: (feature: string) => void
}) {
  const group = section.group!
  const [open, setOpen] = useState(() => readGroupOpen(GROUPS_OPEN_STORAGE_KEY, group, false))
  const toggle = (): void => setOpen((v) => { const next = !v; writeGroupOpen(GROUPS_OPEN_STORAGE_KEY, group, next); return next })
  // The worst row drives the section's summary chip (same comparator).
  const worst = section.rows.reduce((acc, r) =>
    featureChipState(r.flight, r.activity, r.derived).rank < featureChipState(acc.flight, acc.activity, acc.derived).rank ? r : acc, section.rows[0])
  return (
    <section data-testid={`flight-group-${group}`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        data-testid={`flight-group-toggle-${group}`}
        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
        style={{ border: '1px solid transparent' }}
      >
        <span
          aria-hidden="true"
          className="inline-flex shrink-0 transition-transform duration-150"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'none' }}
        >
          <ChevronRightIcon />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          {group}
        </span>
        <span className="cl-count-chip shrink-0">{section.rows.length}</span>
        <FlightStatusChip flight={worst.flight} activity={worst.activity} derived={worst.derived} />
        {/* Invisible arrow-width spacer: aligns the group's status chip with the
         *  trailing '→' column on every row below (rows reserve this width). */}
        <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'transparent' }}>→</span>
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-1 pl-4">
          {section.rows.map((row) => (
            <PickerRow
              key={row.flight?.flightId ?? `activity-${row.feature}`}
              row={row}
              onPick={onPick}
              onPickActivity={onPickActivity}
              onStartFlight={onStartFlight}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/** Row for a feature with no flight record (R49): same anatomy as a flight row
 *  — name, mini rail, chip — with the rail showing the evidence-DERIVED
 *  progress (which steps standalone work already completed; chip "idle").
 *  With zero evidence the rail renders fully greyed (all-pending squares at
 *  reduced opacity, per the mock review: squares, never a dash; chip "not
 *  flown"). Clicking opens the feature-scoped flight launcher either way. */
export function NotFlownRow({
  feature,
  derived,
  onStart,
}: {
  feature: string
  derived?: Array<{ key: FlightStageKey; status: FlightStageStatus }>
  onStart: (feature: string) => void
}) {
  const chip = featureChipState(null, undefined, derived)
  return (
    <button
      type="button"
      data-testid={`not-flown-${feature}`}
      onClick={() => onStart(feature)}
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
      style={{ border: '1px solid var(--border-default)' }}
      title={`${feature}: ${chip.title}`}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" style={{ color: 'var(--text-secondary)' }}>{feature}</span>
      <span style={{ opacity: chip.label === 'not flown' ? 0.55 : 1 }}>
        <StageMiniRail stages={derived ?? []} />
      </span>
      <FlightStatusChip flight={null} derived={derived} />
      <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>→</span>
    </button>
  )
}

/** Row for a feature with live activity but no flight record (a standalone
 *  run / portify / authoring job): same shape as a flight row, the live
 *  progress chip always carrying the state (R39 — no "no flight" label), and
 *  clicking opens the flights view. */
export function ActivityOnlyRow({
  feature,
  activity,
  derived,
  onOpen,
}: {
  feature: string
  activity: FeatureActivity
  derived?: Array<{ key: FlightStageKey; status: FlightStageStatus }>
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
      <StageMiniRail stages={activityStages(activity.kind, derived)} />
      <FlightStatusChip flight={null} activity={activity} />
      <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>→</span>
    </button>
  )
}

/** Row for a pre-flight (plan-features) task — the intent breakdown running
 *  BEFORE any feature exists. No stage rail (nothing has entered the pipeline);
 *  the intent text is the label, the chip carries the state ("planning" while
 *  the agent judges, "to review" once it settles), and clicking reopens the
 *  new-flight dialog attached to the task. */
export function PreFlightRow({
  task,
  onOpen,
}: {
  task: PlanFeaturesTask
  onOpen: (taskId: string) => void
}) {
  const chip = preFlightChipState(task)
  return (
    <li>
      <button
        type="button"
        data-testid={`pre-flight-open-${task.taskId}`}
        onClick={() => onOpen(task.taskId)}
        className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
        style={{ border: '1px solid var(--border-default)' }}
        title={`${chip.title} — ${task.description}`}
      >
        <span aria-hidden="true" className="shrink-0" style={{ color: 'var(--text-muted)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2 11 13" />
            <path d="M22 2 15 22l-4-9-9-4Z" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
          {task.description}
        </span>
        <Chip testId="pre-flight-status-chip" chrome="border" tone={chip.tone} label={chip.label} width={72} title={chip.title} />
        <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>→</span>
      </button>
    </li>
  )
}
