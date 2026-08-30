import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type { ExternalWorkCheckpointData, FlightEntryOptions, FlightIndexEntry, FlightManifest, FlightStage, FlightStageKey } from '@/shared/api/client'
import { capitalizeFirst } from '@/shared/lib/format'
import { StatusDot, useEscapeToClose } from '@/shared/ui/atoms'
import { Chip } from '@/shared/ui/StatusChip'
import { DisabledControlTooltip } from '@/shared/ui/Tooltip'
import { FLIGHT_STATUS_TONE, flightStatusLabel } from './FlightsPill'
import { ACTIVITY_CHIP } from './FlightChipState'
import { EXTERNAL_WORK_COPY, externalMutationTooltip, isExternallyDriven, type ExternalMutationOwner } from '../lib/external-work'
import { ACTIVITY_STAGE, type FeatureActivity, type FeatureExternalHistory } from '../state/feature-activity'
import type { FlightLauncherIntent } from '@/shared/state/nav-state'
import type { ConfigTab } from '@/shared/lib/workspace-view-state'
import { STAGE_BLURB, STAGE_COMPANION, STAGE_ICON, formatStageDuration, stageLabel, stageRailRows, stageStatusTone } from './stage-meta'
import { stageStateLine } from './StageStatusLines'
import {
  buildDerivedManifest,
  derivedEntryStage,
  derivedFlightFeature,
  type DerivedStage,
} from '../lib/derived-stages'
import { DownloadEvaluationAction } from './CheckpointControls'
import { ContinueMenu, FlightMenu } from './FlightControls'
import { FlightTakeoverAction } from './FlightTakeoverAction'
import { FlightDrillThroughs, FlightPage } from './FlightPage'
import { FlightSummaryStrip } from './FlightSummaryStrip'
import { StageDetail, truncate } from './StageDetail'

// Flight detail — the routed full-screen view (?view=flights&flight=<id>)
// that owns a flight's lifecycle: a stage rail on the left (harness-computed
// verdict per stage), the selected stage's "trailer" on the right (R16): one
// state line, the agent's identity + live output where an agent acts, and a
// view-details affordance — the raw evidence/log stay behind the disclosure,
// the real surfaces behind the drill-through. The flights *list* is the picker
// dialog (FlightsPickerDialog, `?view=flights` with no flight) — this view only
// renders a selected flight. Live via `flights-changed` events (refreshKey) + a
// gentle poll while the flight is active.

/** Stage key → the sidecar dir its adapter pins an agent-session ref into.
 *  Stages without an agent (similarity, scaffold, run…) have no entry.
 *  Portify HAS an agent but no entry either: its session ref lives under the
 *  workflow's own dir, so its stage tails a `{kind:'portify'}` source keyed by
 *  the pinned workflowId instead (see `activitySource` in FlightStageView). */
export const AGENT_STAGE_DIRS: Partial<Record<FlightStageKey, string>> = {
  'scout': 'scout',
  'prd-summary': 'prd-summary',
  'specs-coverage': 'specs-coverage',
}

export function FlightDetail({
  flightId,
  refreshKey,
  liveFlight,
  onBackToList,
  onNavigateFlight,
  onClose,
  onStartFlight,
  onOpenConfig,
  configRefreshKey,
  docsRefreshKey,
  activity,
  externalHistory,
  derivedStages,
  drill,
  stage: routedStage,
  onSelectStage,
  indexEntry,
}: {
  flightId: string
  refreshKey: number
  /** The manifest `/ws/flights` pushed for this flight. When present it IS the
   *  record — the fetch below is only how a settled flight (which the server
   *  does not snapshot, because it will never change again) gets read. */
  liveFlight?: FlightManifest | null
  onBackToList: () => void
  /** Select a different flight — used by the derived→real redirect (R81). */
  onNavigateFlight?: (flightId: string | null) => void
  onClose: () => void
  onStartFlight?: (feature: string, intent?: FlightLauncherIntent, fromStage?: FlightStageKey | null) => void
  onOpenConfig?: (feature: string, tab?: ConfigTab) => void
  configRefreshKey?: number
  docsRefreshKey?: number
  /** Per-feature live activity — drives the run row's live icon (R64). */
  activity?: Map<string, FeatureActivity>
  /** Persistent external provenance — keeps the Activity rail honest after a
   *  standalone task settles and drops out of the live activity map. */
  externalHistory?: FeatureExternalHistory
  derivedStages?: Map<string, DerivedStage[]>
  drill: FlightDrillThroughs
  /** The selected stage, when App owns it (routed as `?stage=…`) — null is
   *  follow-mode. Controlled/uncontrolled hybrid: pass BOTH or neither. Without
   *  them the pick stays internal, which is how this component's own tests run
   *  it standalone. */
  stage?: FlightStageKey | null
  onSelectStage?: (stage: FlightStageKey | null) => void
  /** The flight's row from the `/ws/flights` index, when the caller holds it.
   *  A settled flight is not snapshotted on the push channel, so a cold open
   *  used to blank the WHOLE page behind "Loading flight…" until REST resolved
   *  — while the index already carried the feature, status and every stage's
   *  status. The seed renders the header, strip and rail immediately; only the
   *  stage pane waits for the manifest. */
  indexEntry?: FlightIndexEntry | null
}) {
  // R81 — derived mode: `flightId` is a `feature:<name>` token, so there is no
  // record to GET. The rail comes from live workspace evidence and everything
  // below renders from a client-only pseudo-manifest, unchanged.
  const derivedFeature = derivedFlightFeature(flightId)
  const derivedRail = derivedFeature ? derivedStages?.get(derivedFeature) : undefined
  const [derivedPrefill, setDerivedPrefill] = useState<{ repoPaths: string[]; description: string; env: string; evidence?: FlightEntryOptions['evidence'] } | null>(null)
  const [fetched, setFlight] = useState<FlightManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ownStage, setOwnStage] = useState<FlightStageKey | null>(null)
  const selectedStage = onSelectStage ? routedStage ?? null : ownStage
  const setSelectedStage = onSelectStage ?? setOwnStage
  // StageDetail remounts when the rail selection changes. Keep each stage's
  // explicit Activity choice here so leaving a stage does not reset it to the
  // live/settled default when the user comes back.
  const [activityOpenByFlight, setActivityOpenByFlight] = useState<
    Record<string, Partial<Record<FlightStageKey, boolean>>>
  >({})
  const setStageActivityOpen = useCallback((stageKey: FlightStageKey, open: boolean): void => {
    setActivityOpenByFlight((current) => {
      const flightState = current[flightId] ?? {}
      if (flightState[stageKey] === open) return current
      return { ...current, [flightId]: { ...flightState, [stageKey]: open } }
    })
  }, [flightId])
  // R71/W1: one inline error line under the header — every header/run control
  // failure lands here instead of a silent `.catch(() => {})`.
  const [actionError, setActionError] = useState<string | null>(null)

  // Read through a ref so `refetch` keeps a stable identity across pushes (it
  // is an effect dep and a control-call callback; churning it would re-run both
  // on every frame).
  const hasLiveRef = useRef(liveFlight != null)
  hasLiveRef.current = liveFlight != null

  const refetch = useCallback((): void => {
    // The push channel is already carrying this flight — asking REST for what
    // the server just sent is the round trip this channel exists to remove.
    if (hasLiveRef.current) return
    if (derivedFeature) {
      // No record to load. One entry call supplies the repo/env prefill the
      // panels show — and answers "has a record appeared since?", which is how
      // the token self-heals: the moment a flight is minted for this feature
      // (conducted from here, or from anywhere else), we hand over to it so the
      // URL can never point at a stale derived view.
      api.getFlightEntryOptions(derivedFeature)
        .then((o) => {
          setError(null)
          setDerivedPrefill({ repoPaths: o.prefill.repoPaths, description: o.prefill.description, env: o.prefill.env, evidence: o.evidence })
          if (o.flight) onNavigateFlight?.(o.flight.flightId)
        })
        .catch(() => { /* prefill is best-effort — the rail stands on its own */ })
      return
    }
    api.getFlight(flightId)
      .then((m) => { setFlight(m); setError(null) })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [flightId, derivedFeature, onNavigateFlight])

  const derivedManifest = useMemo(
    () => (derivedFeature && derivedRail ? buildDerivedManifest(derivedFeature, derivedRail, derivedPrefill ?? undefined) : null),
    [derivedFeature, derivedRail, derivedPrefill],
  )
  // The index-entry seed: enough manifest to paint the header, strip and rail
  // on a cold open (see the `indexEntry` prop). `seeded` gates everything the
  // index genuinely cannot answer — fabricated `opts` must not render as facts.
  const seed = useMemo<FlightManifest | null>(() => {
    if (!indexEntry || indexEntry.flightId !== flightId) return null
    return {
      flightId: indexEntry.flightId,
      feature: indexEntry.feature,
      repoPaths: indexEntry.repoPaths ?? [],
      description: '',
      // `stageProducer` is real index data and gates the read-only treatment of
      // an externally driven flight — the rest are placeholders `seeded` hides.
      opts: { env: 'local', coverageTarget: 100, yolo: false, ...(indexEntry.stageProducer ? { stageProducer: indexEntry.stageProducer } : {}) },
      status: indexEntry.status,
      ...(indexEntry.pauseReason ? { pauseReason: indexEntry.pauseReason } : {}),
      currentStage: indexEntry.currentStage,
      stages: (indexEntry.stages ?? []).map((s) => ({ key: s.key, status: s.status })),
      createdAt: indexEntry.createdAt,
      updatedAt: indexEntry.updatedAt,
      ...(indexEntry.endedAt ? { endedAt: indexEntry.endedAt } : {}),
    }
  }, [indexEntry, flightId])
  const flight = derivedManifest ?? (derivedFeature ? null : (liveFlight ?? fetched ?? seed))
  const seeded = !derivedManifest && !derivedFeature && !liveFlight && !fetched && seed != null
  /** The stage a "Continue" would enter at — first one without evidence. */
  const derivedEntry = derivedRail ? derivedEntryStage(derivedRail) : null

  /** Fire a flight control call: refetch on success, surface failure inline. */
  const act = useCallback((call: () => Promise<unknown>, onSuccess?: () => void): void => {
    setActionError(null)
    call()
      .then(() => { (onSuccess ?? refetch)() })
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
  }, [refetch])

  // R71/W1: Escape is the keyboard exit to the workspace (the Close button is
  // gone — the breadcrumb + Flights pill cover pointer navigation). It's the
  // BOTTOM layer of the shared Escape stack: an open dialog or header menu
  // registers above it and takes the first press, so Escape only exits the
  // page once nothing else is open.
  useEscapeToClose(onClose)

  // "Respond →": return selection to follow-mode (auto-pick lands on the parked
  // stage) and bring its checkpoint card into view.
  const respondJump = useCallback((): void => {
    setSelectedStage(null)
    requestAnimationFrame(() => {
      document.querySelector('[data-testid="checkpoint-controls"], [data-testid="requirements-fork"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [setSelectedStage])

  // R71/W2: switching flights returns selection to follow-mode — a stage pick
  // made on flight A must not survive onto flight B. Guarded on an actual
  // CHANGE rather than firing on mount: the pick is routed now, and a mount is
  // exactly what a refresh or a drill-through's way back produces — clearing
  // there would wipe the stage the URL just restored.
  const seenFlightRef = useRef(flightId)
  useEffect(() => {
    if (seenFlightRef.current === flightId) return
    seenFlightRef.current = flightId
    setSelectedStage(null)
  }, [flightId, setSelectedStage])

  // WS `flights-changed` bumps refreshKey — still worth a re-read for a flight
  // the push channel is not carrying (a settled one that an MCP tool just
  // rewrote). A DERIVED flight has no flight record; its live facts come from
  // the workspace-entry probe, so coverage invalidation must re-read that
  // evidence too. Portify saves change feature config/evidence, so the repos
  // topic joins coverage here. Reconnect invalidates all topics, providing
  // reconciliation when a best-effort event was dropped.
  const derivedEvidenceRefreshKey = derivedFeature ? docsRefreshKey : undefined
  const derivedConfigRefreshKey = derivedFeature ? configRefreshKey : undefined
  useEffect(() => { refetch() }, [refetch, refreshKey, derivedEvidenceRefreshKey, derivedConfigRefreshKey])
  const active = flight?.status === 'running' || flight?.status === 'waiting-for-approval'
  useEffect(() => {
    // Only when the push channel is NOT carrying this flight: no socket (a
    // component test), or a server too old to serve the channel.
    if (!active || liveFlight) return
    const id = setInterval(refetch, 2000)
    return () => clearInterval(id)
  }, [active, liveFlight, refetch])

  // The rail hides conductor plumbing (R21) and merges run+heal into one user
  // step (R22) — selection and auto-pick both work on these visible rows.
  // While a run for this feature is live, the run row reads `running` (blue +
  // pulse) instead of its settled verdict — the icon must never show a green
  // tick over a run that is still working (R64).
  const featureActivity = flight ? activity?.get(flight.feature) : undefined
  const featureExternalHistory = flight ? externalHistory?.get(flight.feature) : undefined
  // A verify run is a run in verify mode — the run row must read live for it
  // exactly as for a normal run.
  const runLive = featureActivity != null && ACTIVITY_STAGE[featureActivity.kind] === 'run'
  // A recorded flight keeps pointing at the run it conducted. A DERIVED flight
  // has no such record, so its live run identity comes from the shared run
  // stream. This is display-only: it never navigates or starts another run.
  const derivedActiveRunId = derivedFeature && runLive ? featureActivity.runId : undefined
  const railRows = useMemo(() => {
    const rows = flight ? stageRailRows(flight.stages) : []
    return runLive ? rows.map((r) => (r.key === 'run' && r.status !== 'running' ? { ...r, status: 'running' as const } : r)) : rows
  }, [flight, runLive])

  // Default the selected stage to the one that needs eyes: waiting → running →
  // first failed → the row that resumes next → last done. The user's explicit
  // pick wins. Parallel setup is the one background exception: once Report is
  // ready, its ordinary pending/running/done states stay in the rail while the
  // main panel keeps the deliverable in front. A checkpoint or failure still
  // takes focus because it needs the user. (R78: a paused flight whose current
  // row is half-finished has no `done` row after it, so without the pending
  // fallback the panel would open on "Pick a stage." instead of the step the
  // user just paused.)
  const autoStage = useMemo((): FlightStageKey | null => {
    const report = railRows.find((stage) => stage.key === 'evaluation-export' && stage.status === 'done')
    const parallelSetup = railRows.find((stage) => stage.key === 'portify')
    const reportForeground = report && parallelSetup
      && (parallelSetup.status === 'pending' || parallelSetup.status === 'running'
        || parallelSetup.status === 'done' || parallelSetup.status === 'skipped')
      ? report
      : undefined
    const pick =
      railRows.find((s) => s.status === 'waiting-for-approval')
      ?? railRows.find((s) => s.status === 'running' && !(reportForeground && s.key === 'portify'))
      ?? railRows.find((s) => s.status === 'failed')
      ?? reportForeground
      ?? railRows.find((s) => s.status === 'running')
      ?? railRows.find((s) => s.status === 'pending')
      ?? [...railRows].reverse().find((s) => s.status === 'done')
    return pick?.key ?? null
  }, [railRows])
  const stageKey = selectedStage ?? autoStage
  const row = railRows.find((s) => s.key === stageKey) ?? null
  const stage = flight?.stages.find((s) => s.key === stageKey) ?? null
  // The pair-merged rows (run+heal, scaffold+env-capture, docs+prd-summary)
  // carry their folded companion so its facts/checkpoint/log surface too.
  const companionKey = stageKey ? STAGE_COMPANION[stageKey] : undefined
  const companionStage = (companionKey ? flight?.stages.find((s) => s.key === companionKey) : null) ?? null

  // A read failure only blanks the view when there is nothing else to show.
  // With a pushed manifest in hand the record is NOT missing, and a transient
  // GET failure must not replace a live flight with "could not be loaded".
  if (error && !flight) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-xs text-muted">
        <div>Couldn't open this flight. {error}</div>
        <button type="button" onClick={onBackToList} className="cl-button px-2.5 py-1 text-xs">All flights</button>
      </div>
    )
  }
  if (!flight) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted">Loading flight…</div>
  }

  // The flight is the agent's, not just the step it happens to be on. This
  // page's earlier version keyed every external cue off the parked CHECKPOINT
  // being a hand-off, which meant the moment such a flight stopped on a real
  // question — a prd-source fork, a config approval — the cues vanished and it
  // went back to demanding a click for a flight this reader does not drive.
  // A derived pseudo-manifest has no record and no driving client.
  const externallyDriven = !derivedFeature && isExternallyDriven(flight)
  // Standalone external work on this SUITE (a skill the user invoked — author,
  // coverage, portify, export — running in their own agent) makes this page
  // read-only the same way an externally driven flight does: monitor here, act
  // there. Distinct flag because the copy differs — nothing is "driving this
  // flight" — and because it gates the derived-flight controls too.
  const externalSuiteWork = !externallyDriven && featureActivity?.external === true
  const externalMutationOwner: ExternalMutationOwner | undefined = externallyDriven
    ? 'flight'
    : externalSuiteWork ? 'suite' : undefined
  // What the CHIP says. A park is a park: whether the agent is holding a step
  // it was handed or a question it has to answer, the flight is progressing
  // inside that agent and "Needs approval" is a lie either way. Only the
  // flight's own pauses fall through to their real labels.
  const agentHolding = externallyDriven && flight.status === 'waiting-for-approval'
  const externalWorkCheckpoint = agentHolding
    ? flight.stages.find((candidate) => (
        candidate.status === 'waiting-for-approval'
        && candidate.checkpoint?.kind === 'external-work'
      ))?.checkpoint
    : undefined
  const takeoverRequested = externalWorkCheckpoint != null
    && typeof (externalWorkCheckpoint.data as ExternalWorkCheckpointData | undefined)?.takeoverRequestedAt === 'string'
  const suiteActivityChip = externalSuiteWork && featureActivity ? ACTIVITY_CHIP[featureActivity.kind] : null
  const tone = agentHolding
    ? FLIGHT_STATUS_TONE['running']
    : suiteActivityChip?.tone ?? FLIGHT_STATUS_TONE[flight.status]
  const evalStage = flight.stages.find((s) => s.key === 'evaluation-export') ?? null
  return (
    <>
      <header className="cl-shell-bar flex items-center gap-3 px-4 py-2.5">
        {/* R71/W1: the title IS the breadcrumb — "Flights" links back to the
            picker (the always-visible Flights pill is the second way back), so
            navigation costs no button. Controls are exactly one state-dependent
            primary + the ⋯ menu — 2 buttons max in every state. */}
        {/* R72: one line answers "which flight, what state" — breadcrumb,
            name, chip, side by side. Repos + intent live on the Repo scan
            stage. */}
        <h1 className="flex min-w-0 flex-1 items-center gap-2 text-[13.5px] font-semibold">
          <button
            type="button"
            data-testid="flight-breadcrumb"
            onClick={onBackToList}
            className="shrink-0 font-normal underline-offset-2 transition-colors hover:underline text-muted"
            title="All flights"
          >
            Flights
          </button>
          <span aria-hidden="true" className="shrink-0 font-normal text-muted">/</span>
          <span className="min-w-0 truncate">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mr-1.5 inline-block align-[-1px]">
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22l-4-9-9-4Z" />
            </svg>
            {flight.feature}
          </span>
          <Chip
            testId="flight-status"
            chrome="fill"
            tone={tone}
            fontSize={10}
            // R81: a derived flight was never paused or interrupted — its steps
            // were simply completed outside the conductor, so it must not
            // borrow the record-only "paused by you / a stage failed" copy.
            title={agentHolding
              ? EXTERNAL_WORK_COPY.headerTitle
              : suiteActivityChip
              ? suiteActivityChip.title
              : derivedFeature
              ? (flight.status === 'done'
                ? "Every step is done. It was finished outside Canary's own pipeline, so there is no flight history to show"
                : 'Some steps were done outside Canary — Continue runs the rest here')
              : flight.status === 'paused'
              ? (flight.pauseReason === 'user' ? 'Paused by you — Continue resumes it'
                : flight.pauseReason === 'restart' ? 'Interrupted by a server restart — Continue resumes it'
                : 'A step failed — Continue retries it')
              : undefined}
            icon={flight.status === 'running' || agentHolding || suiteActivityChip ? <StatusDot state="running" className="shrink-0" /> : undefined}
            label={agentHolding
              ? EXTERNAL_WORK_COPY.headerLabel
              : suiteActivityChip
              ? capitalizeFirst(suiteActivityChip.label)
              : capitalizeFirst(derivedFeature && flight.status !== 'done' ? 'idle' : flightStatusLabel(flight.status))}
          />
        </h1>
        {/* The one primary: the state's obvious next action. Internal running
            work has none. An external hand-off replaces the inapplicable
            Respond/Pause pair with its one web-owned escape route. Genuine
            questions on an externally driven flight still render their normal
            control inert, because the owning agent answers those. */}
        {externalWorkCheckpoint ? (
          <FlightTakeoverAction
            flightId={flightId}
            requested={takeoverRequested}
            onResponded={refetch}
            onError={setActionError}
          />
        ) : flight.status === 'waiting-for-approval' && (
          <DisabledControlTooltip>
            <button
              type="button"
              data-testid="flight-primary-respond"
              onClick={respondJump}
              disabled={externalMutationOwner != null}
              className="cl-button-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-45"
              title={externalMutationOwner
                ? externalMutationTooltip(externalMutationOwner, 'answer this checkpoint')
                : 'Jump to the question the flight is waiting on'}
            >
              Respond →
            </button>
          </DisabledControlTooltip>
        )}
        {/* R74: one button per state. Active → Pause (immediate + honest —
            agent killed, run aborted, repo freed; every stage re-runs cleanly).
            Settled → ONE Continue menu absorbing resume / repeat-a-step /
            start-over: "Resume at <stage>" (paused) + "From a step…" (+ optional
            what-went-wrong note that reaches the agent's prompt). */}
        {(flight.status === 'running' || flight.status === 'waiting-for-approval') && !externalWorkCheckpoint && (
          <DisabledControlTooltip>
            <button
              type="button"
              data-testid="flight-pause"
              onClick={() => act(() => api.pauseFlight(flightId))}
              // Nothing here can stop work running inside the user's own agent:
              // pausing from this side would park the flight while the agent kept
              // going, and its result would then be discarded as stale. Kept
              // visible and disabled for genuine external decisions so the
              // tooltip names where it moved. During an external-work hand-off,
              // the header's takeover action replaces Pause entirely: that is
              // the only safe way to transfer ownership without discarding the
              // external agent's eventual result.
              disabled={externalMutationOwner != null}
              className="cl-button px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-45"
              title={externalMutationOwner
                ? externalMutationTooltip(externalMutationOwner, 'pause this work')
                : 'Stops everything — the agent, the test run, and any repair. Continue starts this step again.'}
            >
              ⏸ Pause
            </button>
          </DisabledControlTooltip>
        )}
        {/* R81 — a derived flight has no record, so every RECORD-scoped control
            (resume / redo / abort / download) would call an id that doesn't
            exist. It gets one primary instead: conduct the rest from the first
            step without evidence, or — with every step already done — fly it
            again from the top. Both hand off to the launcher, which mints the
            record.
            The ⋯ menu is NOT record-scoped and stays: its one action deletes the
            SUITE (folder + history) through the feature-scoped API, and a
            derived flight only exists because that folder does. Hiding it with
            the rest denied a perfectly valid action on every suite that was set
            up outside the conductor. */}
        {derivedFeature ? (
          <>
            <DisabledControlTooltip>
              <button
                type="button"
                data-testid="derived-conduct"
                onClick={() => onStartFlight?.(derivedFeature, derivedEntry ? 'refly' : 'fresh', derivedEntry)}
                disabled={externalMutationOwner != null}
                className="cl-button-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-45"
                title={externalMutationOwner
                  ? externalMutationTooltip(externalMutationOwner, 'start or continue a flight')
                  : derivedEntry
                  ? `Continue this suite from ${stageLabel(derivedEntry)} — finished steps are kept`
                  : 'Every step is done — start a fresh flight to fly it again'}
              >
                {derivedEntry ? `Continue from ${stageLabel(derivedEntry)}` : 'Fly again'}
              </button>
            </DisabledControlTooltip>
            <FlightMenu flight={flight} derived onAction={act} onDeleted={onBackToList} externalMutationOwner={externalMutationOwner} />
          </>
        ) : (
          <>
            {flight.status === 'done' && evalStage && (
              <DownloadEvaluationAction flight={flight} stage={evalStage} testId="flight-primary-download" primary />
            )}
            {(flight.status === 'paused' || flight.status === 'failed' || flight.status === 'aborted' || flight.status === 'done') && (
              <ContinueMenu flight={flight} onAction={act} onStartFlight={onStartFlight} externalMutationOwner={externalMutationOwner} />
            )}
            <FlightMenu flight={flight} onAction={act} onDeleted={onBackToList} externalMutationOwner={externalMutationOwner} />
          </>
        )}
        <button
          type="button"
          data-testid="flight-close"
          aria-label="Close"
          title="Close (Esc)"
          onClick={onClose}
          className="cl-icon-button h-7 w-7 shrink-0 text-muted"
        >
          ✕
        </button>
      </header>
      {actionError && (
        <div
          data-testid="flight-action-error"
          className="flex items-center gap-2 border-b px-4 py-1.5 text-[11px] border-line text-danger"
        >
          <span className="min-w-0 flex-1 truncate" title={actionError}>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="cl-button min-h-6 shrink-0 px-2 py-0.5 text-[10.5px]">Dismiss</button>
        </div>
      )}

      <FlightSummaryStrip
        flight={flight}
        // `seeded` rides the derived flag: the seed's `opts` are fabricated
        // defaults, so the Agent item (which reads them) must not render until
        // the real manifest lands.
        derived={derivedFeature != null || seeded}
        onSelectStage={setSelectedStage}
        // R81: no record → nothing to toggle. Autopilot is chosen in the
        // launcher when this suite is actually conducted. A seed doesn't know
        // the stored value, so the toggle waits for the manifest too.
        onToggleAutopilot={derivedFeature || seeded ? undefined : (next) => act(() => api.setFlightAutopilot(flight.flightId, next))}
        // Autopilot decides checkpoints — flipping it changes what the agent's
        // flight answers for itself, so it is the agent's setting while the
        // agent is driving. Disabled with a reason, not hidden: the toggle's
        // VALUE is still information the reader wants.
        autopilotLockedReason={externalMutationOwner
          ? externalMutationTooltip(externalMutationOwner, 'change Autopilot')
          : undefined}
      />

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Flight steps"
          className="flex w-[240px] shrink-0 flex-col gap-0.5 overflow-auto border-r border-line p-2 scrollbar-thin"
          style={{ scrollbarGutter: 'stable' }}
        >
          {/* R72 (restyled): follow-mode now reads as a real button, not a bare
              text link — the standard bordered `cl-button` chrome. Still
              subordinate to Continue (10px, tucked in the rail corner), just
              unmistakably clickable. ONE element in both states so nothing
              jumps: a sky ● + "Follow" in a pressed/selected look while
              auto-following, a "↺ Follow" resume button once a manual pick
              parks the selection. Enabled in both — clicking while already
              following is a harmless no-op. */}
          {/* R85: the same rubric + dashed-rule header the run stage's bands use
              (FailingTests, Previous runs), so the rail's label band reads as a
              header ABOVE the list instead of the list's first row. The rule is
              what does the separating — the strip no longer needs a fixed
              height, so the pill sizes to its own content and stops filling the
              band edge to edge. `mb-1.5` puts real air between label and list;
              the old 2px flex gap glued the button to "Repo scan". */}
          <div className="mb-1.5 flex items-center gap-2 px-2">
            {/* "Steps", not "Stages": every tooltip and card in the pane says
                "step" — one word for one thing. */}
            <span className="cl-rubric shrink-0">
              Steps
            </span>
            <span className="h-px flex-1 border-t border-dashed border-line" />
            <button
              type="button"
              data-testid={selectedStage === null ? 'rail-following' : 'rail-resume-follow'}
              aria-pressed={selectedStage === null}
              onClick={() => setSelectedStage(null)}
              className="cl-button flex shrink-0 items-center gap-1 px-1.5 py-1 text-[10px] leading-none"
              style={selectedStage === null
                ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border-default))', background: 'var(--bg-selected)' }
                : undefined}
              title={selectedStage === null
                ? 'Following whichever step needs you'
                : 'Go back to following the step that needs you'}
            >
              <span aria-hidden="true" className="text-[9px]" style={selectedStage !== null ? { color: 'var(--accent)' } : undefined}>
                {selectedStage === null ? '●' : '↺'}
              </span>
              Follow
            </button>
          </div>
          {railRows.map((s) => {
            const selected = s.key === stageKey
            const t = stageStatusTone(s.status)
            // A merged row's duration sums its primary + folded companion
            // (run→heal, scaffold→env-capture, docs→prd-summary) — R61. Work
            // time, not wall clock: checkpoint parks and pauses don't count.
            const primary = flight.stages.find((st) => st.key === s.key)
            const folded = flight.stages.find((st) => st.key === STAGE_COMPANION[s.key])
            const duration = formatStageDuration(primary, folded)
            // R84: the stage panel no longer paints its "where are we" sentence —
            // it rides here instead, under the static blurb, so hovering a rail
            // row still answers both "what is this step" and "what's it done".
            const stateLine = primary ? stageStateLine(primary, flight, folded) : null
            const tooltip = stateLine ? `${STAGE_BLURB[s.key]}\n\n${stateLine}` : STAGE_BLURB[s.key]
            return (
              <button
                key={s.key}
                type="button"
                data-testid={`stage-rail-${s.key}`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => setSelectedStage(s.key)}
                title={tooltip}
                className={`cl-hover-row flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors${selected ? ' bg-selected' : ''}`}
              >
                {/* Status hue stays a computed token string (one source of
                    truth in stageStatusTone), so this one keeps `color`. */}
                <span className="w-3 shrink-0 text-center font-semibold" style={{ color: t }} aria-hidden="true">
                  {STAGE_ICON[s.status]}
                </span>
                <span className={`min-w-0 flex-1 truncate${s.status === 'pending' ? ' text-muted' : ''}`}>
                  {s.label}
                </span>
                {s.note && (
                  <span
                    data-testid={`stage-rail-note-${s.key}`}
                    className="cl-rubric shrink-0 rounded bg-warning/12 px-1 text-warning"
                  >
                    {s.note}
                  </span>
                )}
                {duration && s.status !== 'running' && (
                  <span className="shrink-0 text-[10px] text-muted font-mono">
                    {duration}
                  </span>
                )}
                {s.status === 'running' && <StatusDot state="running" className="shrink-0" />}
              </button>
            )
          })}
        </nav>

        <main className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
          {!stage || !row ? (
            // The residual hole behind `autoStage`: a record whose rail hasn't
            // resolved yet (an index-entry seed, a manifest with no stages).
            // Padded like every other pane state, and it says what's happening
            // instead of issuing an instruction the rail can't satisfy.
            <div className="p-3 text-xs text-muted">
              {seeded ? 'Loading the flight’s steps…' : 'Pick a step from the list on the left.'}
            </div>
          ) : (
            <StageDetail
              key={stage.key}
              flightId={flightId}
              flight={flight}
              row={row}
              stage={stage}
              companion={companionStage}
              runLive={runLive}
              activeRunId={derivedActiveRunId}
              activity={featureActivity}
              externalHistory={featureExternalHistory}
              activityOpen={activityOpenByFlight[flightId]?.[stage.key]}
              onActivityOpenChange={(open) => setStageActivityOpen(stage.key, open)}
              externalMutationOwner={externalMutationOwner}
              onResponded={refetch}
              onActionError={setActionError}
              onStartFlight={onStartFlight}
              onOpenConfig={onOpenConfig}
              configRefreshKey={configRefreshKey}
              docsRefreshKey={docsRefreshKey}
              drill={drill}
            />
          )}
        </main>
      </div>
    </>
  )
}

/** The stage's drill-through: a lens button into the real underlying surface.
 *  Unlocks only once the stage settles (done / failed) or parks (checkpoint /
 *  paused mid-step) — while it RUNS, the embedded activity rail IS the live
 *  view, and a drill would just split attention across two copies of it. */
export function stageDrillThrough(
  stage: FlightStage,
  flight: FlightManifest,
  drill: FlightDrillThroughs,
  companion: FlightStage | null,
  onOpenConfig?: (feature: string, tab?: ConfigTab) => void,
): { label: string; onClick: () => void } | null {
  if (stage.status === 'running') return null
  const ev = (stage.evidence ?? {}) as Record<string, unknown>
  if (stage.key === 'run' || stage.key === 'heal') {
    const runId = typeof ev.runId === 'string' ? ev.runId : flight.links?.runId
    if (runId && drill.onOpenRun) {
      const open = drill.onOpenRun
      // R82: names WHICH run it opens. The stage now lists the previous runs
      // underneath (each with its own open action), so a bare "run detail" left
      // the user guessing which of them this button meant.
      return { label: 'Latest run →', onClick: () => open(flight.feature, runId) }
    }
  }
  // Requirements drills to the same ledger — that's where the distilled
  // requirements become browsable rows. Gated on the folded prd-summary
  // companion, NOT on the docs row: the docs stage is `done` the moment its
  // source docs are approved, and offering a ledger then opens an empty one.
  if (stage.key === 'docs' && drill.onOpenCoverage && companion?.status === 'done') {
    const open = drill.onOpenCoverage
    return { label: 'Open test coverage →', onClick: () => open(flight.feature) }
  }
  if (stage.key === 'specs-coverage' && drill.onOpenCoverage && stage.status !== 'pending') {
    const open = drill.onOpenCoverage
    return { label: 'Open test coverage →', onClick: () => open(flight.feature) }
  }
  // Flight owns the Parallel-readiness workflow, including live work, review
  // and save. This drill is only a supporting-config lens: the Ports tab holds
  // the slot ↔ env-var map and remove control, then routes back here for work.
  // Unlocks once the stage has been touched at all — settled, skipped, or
  // parked. `pending` alone isn't "never ran": an interrupted stage reverts to
  // pending and keeps its startedAt, and that's exactly when you want the tab.
  if (stage.key === 'portify' && onOpenConfig && (stage.status !== 'pending' || stage.startedAt != null)) {
    return { label: 'Open port settings →', onClick: () => onOpenConfig(flight.feature, 'ports') }
  }
  return null
}
