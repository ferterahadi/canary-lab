import type { FlightIndexEntry, FlightStageKey, FlightStageStatus, FlightStatus, PlanFeaturesTask } from '@/shared/api/client'
import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'
import { ACTIVITY_STAGE, type FeatureActivity, type FeatureActivityKind } from '../state/feature-activity'
import { capitalizeFirst } from '@/shared/lib/format'
import { Chip } from '@/shared/ui/StatusChip'
import { Tooltip } from '@/shared/ui/Tooltip'
import { stageLabel } from './stage-meta'
import { derivedFlightToken } from '../lib/derived-stages'
import { externalWorkChipTitle, flightAwaitsUser, isExternalWorkPark, isExternallyDriven } from '../lib/external-work'

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
  'running': 'var(--running)',
  'waiting-for-approval': 'var(--warning)',
  'paused': 'var(--warning)',
  'done': 'var(--success)',
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
    return { label: 'planning', tone: FLIGHT_STATUS_TONE['running'], live: true, rank: 1, title: 'Judging whether this intent is one suite or several' }
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

/** Chip verb + tooltip + tone per live activity kind (sky = in progress, same
 *  hue as a running flight — the colour means the same thing everywhere).
 *
 *  `healing` is the one amber verb: it borrows the run detail header's own hue
 *  (`RunStatusIndicator` paints healing amber and running sky) so the same state
 *  reads the same everywhere, and it matches the amber wash the suites column
 *  already puts on a healing row. Amber elsewhere in this vocabulary means "the
 *  human is the blocker", but those states are all at rest — a healing chip is
 *  `live`, and the suites row it sits on is pulsing.
 *
 *  Every kind states its tone rather than defaulting: an optional field with one
 *  exception is a fallback arm nothing exercises. */
export const ACTIVITY_CHIP: Record<FeatureActivityKind, { label: string; title: string; tone: string }> = {
  'healing': { label: 'healing', title: 'Repair agent working on the failing tests', tone: 'var(--warning)' },
  'running': { label: 'running', title: 'Test run in progress', tone: FLIGHT_STATUS_TONE['running'] },
  'exporting': { label: 'exporting', title: 'Evaluation export in progress', tone: FLIGHT_STATUS_TONE['running'] },
  'portifying': { label: 'portifying', title: 'Port-ification in progress', tone: FLIGHT_STATUS_TONE['running'] },
  'authoring': { label: 'authoring', title: 'Authoring test specs', tone: FLIGHT_STATUS_TONE['running'] },
}

/** Short chip verb for a RUNNING flight, keyed by the stage the conductor is on
 *  — the chip narrates WHAT is happening rather than a flat "running".
 *
 *  EVERY stage declares one. Only `specs-coverage` used to, so ten of eleven
 *  stages fell through to a generic "running": a flight spent most of its
 *  ~25 minutes reporting nothing about where it was, and the stages a first-time
 *  viewer most wants named (repo scan, suite setup, requirements) were exactly
 *  the silent ones. A full Record rather than a Partial so a new stage cannot be
 *  added without deciding what its chip says.
 *
 *  Verbs, not the stage titles, because that is this vocabulary's grammar
 *  (running / healing / portifying); the full title reaches the tooltip via
 *  `stageLabel`. The four that overlap ACTIVITY_CHIP reuse ITS verb, so a job
 *  reads identically whether a flight stage or a standalone action started it.
 *
 *  Kept short deliberately: the chip is fixed at 72px (see FeatureChipBadge), so
 *  nothing here may exceed the width of the pinned widest labels — "to approve"
 *  and "portifying", both 10 characters. */
export const RUNNING_STAGE_CHIP: Record<FlightStageKey, string> = {
  'similarity': 'checking',
  'scout': 'scanning',
  'scaffold': 'setting up',
  'env-capture': 'capturing',
  'docs': 'reading',
  'prd-summary': 'distilling',
  'specs-coverage': 'authoring',
  'portify': 'portifying',
  'run': 'running',
  'heal': 'healing',
  'evaluation-export': 'exporting',
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
 *   0. flight parked on an external-work hand-off → the stage verb (sky, live) —
 *      the step is running in the user's own agent, so it is presented as work
 *      in progress and only the tooltip says where
 *   1. flight parked on any OTHER checkpoint → "to approve"  (amber — the human
 *      is the blocker; outranks live activity because nothing moves until they act)
 *   2. live activity on the feature  → "running" / "healing" / "portifying" /
 *      "authoring" (narrates the absorbed surfaces (runs / portify / wizard
 *      drafts) whether the job was started by a flight stage or standalone;
 *      sky, except the amber "healing" — see ACTIVITY_CHIP)
 *   3. flight conductor active       → the stage verb (sky — "scanning",
 *      "setting up", "distilling", … one per stage; see RUNNING_STAGE_CHIP.
 *      Only a flight with no stage recorded yet says a bare "running")
 *   4. flight paused                 → "paused"      (amber)
 *   5. nothing happening             → the LAST state: "done" / "failed" / "aborted"
 *
 *  A `queued` sibling (paused with pauseReason 'queued' — parked by a
 *  plan-features launch, auto-started by the conductor) is NOT an attention
 *  state: it reads muted/neutral ("queued") and ranks just above never-flown,
 *  since nothing is asked of the human.
 *
 *  R81 — a flightless feature reports on its DERIVED progress, because stages
 *  completed outside the conductor are flight progress (a coverage run, repo /
 *  requirement / docs setup and MCP authoring each complete the same stage the
 *  conductor would have). Every derived stage done → "done", the same word a
 *  recorded flight gets: the row has flown, it just wasn't conducted. Partial
 *  progress → "idle" (nothing is running) with a title that points at the
 *  continue, never at a restart. Zero evidence (or an older server without the
 *  evidence payload) → "not flown".
 */
export function featureChipState(
  flight: Pick<FlightIndexEntry, 'status' | 'currentStage' | 'pauseReason' | 'checkpointKind' | 'stageProducer'> | null,
  activity?: FeatureActivity,
  derived?: Array<{ key: FlightStageKey; status: FlightStageStatus }>,
): FeatureChipState {
  // A hand-off to the client that started the flight is WORK, not a question —
  // it reads exactly like a running flight (same verb, same sky, same pulse,
  // same rank), and only the tooltip says where the work is happening. Checked
  // before the checkpoint branch because it wears the same wire status.
  // Widened past the hand-off: a park on a real QUESTION reads the same way
  // when the agent is the one who answers it. Only the flight's own pauses
  // (stage-failed, restart, user) fall through to the resting branches below,
  // because those are states, not demands.
  if (isExternalWorkPark(flight) || (flight?.status === 'waiting-for-approval' && isExternallyDriven(flight))) {
    const verb = flight?.currentStage ? RUNNING_STAGE_CHIP[flight.currentStage] : 'running'
    return { label: verb, tone: FLIGHT_STATUS_TONE['running'], live: true, rank: 1, title: externalWorkChipTitle(verb) }
  }
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
    return { label: chip.label, tone: chip.tone, live: true, rank: 1, title: chip.title }
  }
  if (!flight) {
    // R49/R81: one row per workspace feature. A derived row opens the flight
    // detail for its evidence — never a start-from-scratch dialog.
    // "Done" means the WHOLE pipeline — a partial rail (or a caller passing a
    // subset) must never read as a finished flight.
    if (derived && derived.length >= FLIGHT_STAGE_KEYS.length && derived.every((s) => s.status === 'done')) {
      return { label: 'done', tone: FLIGHT_STATUS_TONE['done'], live: false, rank: 5, title: 'every step complete — flown outside the conductor' }
    }
    if (derived?.some((s) => s.status !== 'pending')) {
      return { label: 'idle', tone: 'var(--text-secondary)', live: false, rank: 5.8, title: 'part-way through — open to continue from the next step' }
    }
    return { label: 'not flown', tone: 'var(--text-muted)', live: false, rank: 6, title: 'never flown — start a flight' }
  }
  if (flight.status === 'running') {
    return {
      // The one remaining fallback is a flight with no stage recorded yet (just
      // launched) — every KNOWN stage now has its own verb.
      label: flight.currentStage ? RUNNING_STAGE_CHIP[flight.currentStage] : 'running',
      tone: FLIGHT_STATUS_TONE['running'],
      live: true,
      rank: 1,
      title: flight.currentStage ? stageLabel(flight.currentStage) : 'running',
    }
  }
  // R74: a pause the USER chose is a quiet resting state (shelving a flight is
  // now the normal way to park one) — only failure/restart pauses keep the
  // amber "you're the blocker" tone.
  if (flight.status === 'paused' && flight.pauseReason === 'user') {
    return { label: 'paused', tone: 'var(--text-secondary)', live: false, rank: 2, title: 'paused by you — Continue resumes it' }
  }
  const rank = flight.status === 'paused' ? 2 : flight.status === 'failed' ? 3 : flight.status === 'aborted' ? 4 : 5
  return { label: flight.status, tone: FLIGHT_STATUS_TONE[flight.status], live: false, rank, title: flightStatusLabel(flight.status) }
}

/** What a per-suite "open its flight" shortcut should do — the Features column's
 *  hover action (and any other surface that wants one jump from a suite to its
 *  flight). `flightId` is a recorded id when the conductor kept a journal, else
 *  the `feature:` derived token, so the shortcut lands on the SAME flight view
 *  the picker opens. `tone`/`label` are the flight chip's own vocabulary, so the
 *  icon means green-done / sky-running / amber-needs-you without inventing a
 *  second colour language. */
export interface FeatureFlightAction {
  flightId: string
  tone: string
  /** Short state word, e.g. `done` / `idle` / `to approve` — for the tooltip. */
  label: string
  /** The fuller story behind the label (chip tooltip copy). */
  title: string
  /** Something is happening on this suite right now (running flight or a live
   *  standalone job). Drives the suites column's quiet in-flight row wash — a
   *  resting or finished flight gets no cue at all, so a column of flown suites
   *  stays calm. */
  live: boolean
  /** The flight is parked on a checkpoint: blocked on the human rather than
   *  merely busy, so the row wash sits a step heavier (amber, not sky). */
  attention: boolean
}

/** Resolve the shortcut for one suite, or null when there is no flight to open.
 *
 *  Null means "nothing has happened to this suite yet" — no flight record and
 *  no workspace evidence (an older server that sends no evidence block lands
 *  here too). Starting a flight stays with `+ New` and the picker (R40), so the
 *  shortcut simply isn't offered rather than turning into a second launcher.
 *  Every suite that HAS done something gets the jump, because those completed
 *  stages are flight progress (R81) — the same reason the picker routes a
 *  flightless-but-worked feature to the flight detail. */
export function resolveFeatureFlightAction(
  feature: string,
  flights: FlightIndexEntry[],
  activity?: FeatureActivity,
  derived?: Array<{ key: FlightStageKey; status: FlightStageStatus }>,
): FeatureFlightAction | null {
  // First match wins — the same dedupe-by-feature rule the picker rows use, so
  // a suite with several flights opens the one the picker would.
  const flight = flights.find((f) => f.feature === feature) ?? null
  if (!flight && !derived?.some((s) => s.status !== 'pending')) return null
  const chip = featureChipState(flight, activity, derived)
  return {
    flightId: flight?.flightId ?? derivedFlightToken(feature),
    tone: chip.tone,
    label: chip.label,
    title: chip.title,
    live: chip.live,
    // Read off the flight record rather than the chip's rank, so the "blocked on
    // the human" wash tracks the same condition featureChipState branches on —
    // a hand-off is busy, not blocked, so it takes the sky `live` wash instead.
    attention: flightAwaitsUser(flight),
  }
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
  flight: Pick<FlightIndexEntry, 'status' | 'currentStage' | 'pauseReason' | 'checkpointKind'> | null
  activity?: FeatureActivity
  derived?: Array<{ key: FlightStageKey; status: FlightStageStatus }>
}) {
  return <FeatureChipBadge chip={featureChipState(flight, activity, derived)} />
}

/** The chip's rendering, split from the state resolution above so a caller that
 *  already holds a resolved state (the suites column, which gets one from
 *  `resolveFeatureFlightAction`) renders the IDENTICAL chip instead of a
 *  look-alike — one home for the width, tone and tooltip rules. */
export function FeatureChipBadge({ chip }: { chip: Pick<FeatureChipState, 'label' | 'tone' | 'title'> }) {
  return (
    <Chip testId="flight-status-chip" chrome="fill" tone={chip.tone} fontSize={10} label={capitalizeFirst(chip.label)} width={72} title={chip.title} />
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

export function featureName(f: FeatureRef): string {
  return typeof f === 'string' ? f : f.name
}

export function featureStages(f: FeatureRef | undefined): Array<{ key: FlightStageKey; status: FlightStageStatus }> | undefined {
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
