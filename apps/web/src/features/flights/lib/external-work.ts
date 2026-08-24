import type { FlightCheckpointKind, FlightIndexEntry, FlightStageKey, FlightStageStatus, FlightStatus } from '@/shared/api/client'

// An `external-work` park is the one checkpoint kind that is NOT a question.
//
// A flight started over MCP defaults to `stageProducer: 'external'`, so its
// thinking stages (scout, docs, prd-summary, specs↔coverage, portify, heal, the
// localized export rewrite) are handed to the client that started it — the
// user's own Claude/Codex session — instead of a Canary-spawned CLI. The stage
// parks on a checkpoint carrying the prompt and waits for the result to come
// back through `respond_flight_checkpoint`.
//
// The SERVER is right to model that as `waiting-for-approval`: pause clears it,
// resume re-parks it, and the stale-submit gate treats it like any other
// checkpoint. But the web UI read the status literally and reported active work
// as a question for the human — amber "Needs approval", a "Respond →" button,
// an enabled Pause and a "waiting for you" toast, none of which the person
// reading the web UI can act on, because the step is running somewhere else.
//
// So the wire status stays put and the PRESENTATION is derived here: one
// predicate every surface branches on, and one home for the copy, so the chip,
// the header, the rail, the stage card and the toast cannot drift apart.

/** True when this flight is parked on a hand-off to the client that started it,
 *  rather than on a question for the human. Accepts the slim index entry (which
 *  carries `checkpointKind` for exactly this) so the pill, picker, suites column
 *  and toasts can ask without loading a manifest. */
export function isExternalWorkPark(
  flight: { status: FlightStatus; checkpointKind?: FlightCheckpointKind } | null | undefined,
): boolean {
  return flight?.status === 'waiting-for-approval' && flight.checkpointKind === 'external-work'
}

/** Every user-facing line about a hand-off, in one place.
 *
 *  "Your agent" throughout, deliberately: the flight record does not store which
 *  client started it (no `clientKind`), so the copy cannot name Claude or Codex
 *  and must read the same for both. It also draws the distinction that matters —
 *  YOUR agent, over there, as against the agents Canary spawns itself, which
 *  every other surface calls "the agent" or names by stage. */
export const EXTERNAL_WORK_COPY = {
  /** Flight header chip — replaces "Needs approval" for this kind. */
  headerLabel: 'Running in your agent',
  headerTitle: 'Your agent is working on this step. Canary will continue when it finishes.',
  /** Stage card heading + the "where are we" line under it. */
  cardTitle: 'Your agent is working on this step',
  stateLine: 'Canary handed this step to the agent that started the flight and is waiting for the result.',
  /** Shown when `rejectStaleSubmit` discarded a result answering a superseded
   *  hand-off — the re-park is otherwise indistinguishable from the first ask. */
  lateResultNote: 'A late result from an earlier attempt was ignored. This step is still running in your agent.',
} as const

/** Tooltip for the fixed-width feature chip (picker + suites column): the chip
 *  itself is pinned to 72px and cannot hold the phrase, so the verb goes on the
 *  chip ("Scanning") and the whole thing reaches the tooltip. */
export function externalWorkChipTitle(verb: string): string {
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} in your agent`
}

/** The slim per-stage rail off an index entry, presented. The index carries no
 *  per-stage checkpoint — only the flight-level `checkpointKind` — so the mini
 *  rail cannot apply `presentedStageStatus` itself and would paint a hand-off's
 *  cell amber next to a chip that says the step is running. The parked cell is
 *  the flight's `currentStage`, so map exactly that one. */
export function presentedIndexStages(
  entry: Pick<FlightIndexEntry, 'status' | 'checkpointKind' | 'currentStage' | 'stages'>,
): Array<{ key: FlightStageKey; status: FlightStageStatus }> {
  const stages = entry.stages ?? []
  if (!isExternalWorkPark(entry)) return stages
  return stages.map((s) => (
    s.key === entry.currentStage && s.status === 'waiting-for-approval'
      ? { ...s, status: 'running' as FlightStageStatus }
      : s
  ))
}

// ---------------------------------------------------------------------------
// Externally DRIVEN — the whole flight, not just the parked step.
//
// `isExternalWorkPark` above answers "is the current checkpoint a hand-off?",
// which was too narrow: the moment such a flight parked on a genuine question
// (a `prd-source` fork, a `config-approval`), every external cue vanished and
// the page went back to demanding a click — amber chip, Respond →, live Pause —
// for a flight the person reading it does not drive. Whether the UI may act is
// a property of the FLIGHT, so it is read off the flight.
//
// The rule: an externally driven flight is READ-ONLY here. Everything that
// answers a question or moves the pipeline belongs to the agent that started
// it. Two things stay, because neither decides anything on the agent's behalf
// and no MCP tool can do them: Abort (the escape hatch when a client dies) and
// the dirty-repo remedy (the user's own repos). The server enforces the same
// line — see flight-decision-origin.ts — so this is presentation, not security.

/** True while this flight's decisions belong to the MCP client that started
 *  it. Live-only: once the flight settles the agent is gone and the record is
 *  the UI's again (Fly again, Continue from a step, delete). */
export function isExternallyDriven(
  flight: { status: FlightStatus; opts?: { stageProducer?: 'internal' | 'external' }; stageProducer?: 'internal' | 'external' } | null | undefined,
): boolean {
  if (!flight) return false
  // Accepts either shape: the manifest carries it under `opts`, the slim index
  // entry hoists it to the top level (the pill/picker/toasts never load a
  // manifest). One predicate for both keeps the surfaces from disagreeing.
  const producer = flight.opts?.stageProducer ?? flight.stageProducer
  if (producer !== 'external') return false
  return flight.status === 'running' || flight.status === 'waiting-for-approval' || flight.status === 'paused'
}

/** Why a control is inert, said once per control. Each line names WHERE the
 *  action lives now, because "disabled" without a destination is just a dead
 *  end — the user has a session open in another window and needs telling that
 *  is the window to use. */
export const EXTERNAL_DRIVE_COPY = {
  /** Header line, in place of the primary button. */
  banner: 'Driven by your agent — respond from there.',
  bannerTitle:
    'This flight was started by your agent, so it makes the decisions: checkpoints, pause and resume all happen in that session. Aborting is the only control this page keeps.',
  pause: 'Your agent is driving this flight — pause it there, not here.',
  continueFlight: 'Your agent is driving this flight — continue it there, not here.',
  redo: 'Your agent is driving this flight — ask it to re-run the step.',
  autopilot: 'Your agent is driving this flight — autopilot is fixed for as long as it does.',
  /** Replaces the answer buttons on a checkpoint card. The question and its
   *  context still render — the reader wants to know what the flight stopped
   *  on — but answering it is the agent's job. */
  checkpointLine: 'Your agent answers this — it is holding the question now.',
} as const

/** Standalone external work — a skill the user invoked (author, coverage,
 *  portify, export) is working on this SUITE from their own agent session, with
 *  no flight record driving it. The same read-only rule as EXTERNAL_DRIVE_COPY
 *  — the flight page monitors, the agent acts — but its own phrasing: nothing
 *  is "driving this flight", the agent is working on the suite. The predicate
 *  is the feature's live activity (`FeatureActivity.external`), read where the
 *  page already holds it, so there is no second derivation to drift. */
export const EXTERNAL_SUITE_COPY = {
  /** Header line — the counterpart of EXTERNAL_DRIVE_COPY.banner. */
  banner: 'Your agent is working on this suite — follow it below.',
  bannerTitle:
    'A skill you invoked is working on this suite from your own agent session. Monitor it here; act from that session. Controls unlock when it finishes.',
  pause: 'Your agent is working on this suite — nothing here can stop that work.',
  continueFlight: 'Your agent is working on this suite — flights can continue once it finishes.',
  conduct: 'Your agent is working on this suite — start a flight once it finishes.',
  delete: 'Your agent is working on this suite — deleting it now would rip the files out from under that work.',
} as const

/** The question every "does this need a click?" surface is really asking — the
 *  pill's count, the picker's rank-0 sort, the suites column's ordering, the
 *  chip's amber attention wash, the toasts.
 *
 *  It is deliberately ONE function rather than the `status === 'waiting-for-
 *  approval' && !isExternalWorkPark(...)` expression each of those sites used
 *  to inline: the same test written five times is the same test drifting five
 *  ways, and widening it from "not a hand-off" to "not the agent's flight at
 *  all" would otherwise have to be remembered five times. A flight the user's
 *  own agent drives never demands a click here, whatever it is parked on. */
export function flightAwaitsUser(
  flight:
    | { status: FlightStatus; checkpointKind?: FlightCheckpointKind; stageProducer?: 'internal' | 'external' }
    | null
    | undefined,
): boolean {
  if (!flight || flight.status !== 'waiting-for-approval') return false
  return !isExternalWorkPark(flight) && !isExternallyDriven(flight)
}
