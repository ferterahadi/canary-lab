import { isActiveFlightStatus } from '@shared/flights/types'
import { isExternallyDriven } from '@shared/flights/ownership'
import type { CoverageJobIndexEntry } from '@shared/coverage/types'
import { coverageJobStage } from '../lib/coverage-activity'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as flightsApi from '@/shared/api/flights'
import type {
  ExternalWorkCheckpointData,
  FlightEntryOptions,
  FlightIndexEntry,
  FlightManifest,
  FlightStage,
  FlightStageKey,
} from '@shared/flights/types'
import { isActionablePortifyStatus as isActivePortify } from '@shared/portify-index'
import { usePortify } from '@/features/portify/state/PortifyContext'
import { capitalizeFirst } from '@/shared/lib/format'
import { hasFlightAttention } from '@shared/flights/attention'
import { StatusDot } from '@/shared/ui/atoms'
import { useEscapeToClose } from '@/shared/ui/Overlays'
import { Chip } from '@/shared/ui/StatusChip'
import { DisabledControlTooltip, Tooltip } from '@/shared/ui/Tooltip'
import { ACTIVITY_CHIP, featureChipState, FLIGHT_STATUS_TONE, flightStatusLabel } from './FlightChipState'
import { EXTERNAL_WORK_COPY, externalMutationTooltip, isExternalWorkPark, type ExternalMutationOwner } from '../lib/external-work'
import { ACTIVITY_STAGE, presentActivityRunStatus, type FeatureActivity, type FeatureExternalHistory } from '../state/feature-activity'
import type { FlightLauncherIntent } from '@/shared/state/nav-state'
import type { ConfigTab } from '@/shared/lib/workspace-view-state'
import { STAGE_BLURB, StageStatusIcon, presentStageStatus } from './stage-meta'
import { STAGE_COMPANION, stageRowKey } from './StageRail'
import { formatStageDuration } from './StageStatusLines'
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
import { StageDetail } from './StageDetail'
import { FLIGHT_STAGE_SECTIONS } from './flight-sections'
import { useFlightRecord } from '../state/use-flight-record'
import { useLiveCoverage } from '@/shared/state/use-live-coverage'
import { coverageWarning } from '@/shared/ui/CoverageFreshnessIndicator'
import { coverageStageWarning } from './coverage-stage-warning'
import { activityRowKey as rowKeyForActivity, presentedFlightRows } from './presented-flight-rows'
import { displayError } from '@/shared/api/error-message'

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
  activityRequest,
  refreshKey,
  liveFlight,
  onBackToList,
  onNavigateFlight,
  onClose,
  onStartFlight,
  onOpenConfig,
  onOpenSpecReview,
  configRefreshKey,
  docsRefreshKey,
  activity,
  externalHistory,
  coverageJobs = [],
  derivedStages,
  drill,
  stage: routedStage,
  onSelectStage,
  log,
  onOpenLog,
  indexEntry,
  missing = false,
  onFlightMissing,
}: {
  flightId: string
  activityRequest?: number
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
  onOpenSpecReview?: (feature: string, runId: string) => void
  configRefreshKey?: number
  docsRefreshKey?: number
  /** Per-feature live activity — drives the run row's live icon (R64). */
  activity?: Map<string, FeatureActivity>
  /** Persistent external provenance — keeps the Activity rail honest after a
   *  standalone task settles and drops out of the live activity map. */
  externalHistory?: FeatureExternalHistory
  coverageJobs?: CoverageJobIndexEntry[]
  derivedStages?: Map<string, DerivedStage[]>
  drill: FlightDrillThroughs
  /** The selected stage, when App owns it (routed as `?stage=…`) — null is
   *  follow-mode. Controlled/uncontrolled hybrid: pass BOTH or neither. Without
   *  them the pick stays internal, which is how this component's own tests run
   *  it standalone. */
  stage?: FlightStageKey | null
  onSelectStage?: (stage: FlightStageKey | null) => void
  /** The open Activity log entry, when App routes it (`?log=…`). Same hybrid
   *  contract as `stage`; without them the stage's Activity keeps it locally. */
  log?: string | null
  onOpenLog?: (id: string | null) => void
  /** The flight's row from the `/ws/flights` index, when the caller holds it.
   *  A settled flight is not snapshotted on the push channel, so a cold open
   *  used to blank the WHOLE page behind "Loading flight…" until REST resolved
   *  — while the index already carried the feature, status and every stage's
   *  status. The seed renders the header, strip and rail immediately; only the
   *  stage pane waits for the manifest. */
  indexEntry?: FlightIndexEntry | null
  missing?: boolean
  onFlightMissing?: (id: string) => void
}) {
  // R81 — derived mode: `flightId` is a `feature:<name>` token, so there is no
  // record to GET. The rail comes from live workspace evidence and everything
  // below renders from a client-only pseudo-manifest, unchanged.
  const derivedFeature = derivedFlightFeature(flightId)
  const derivedRail = derivedFeature ? derivedStages?.get(derivedFeature) : undefined
  const [derivedPrefill, setDerivedPrefill] = useState<{ repoPaths: string[]; description: string; env: string; evidence?: FlightEntryOptions['evidence'] } | null>(null)
  const record = useFlightRecord(derivedFeature ? null : flightId, liveFlight, !derivedFeature && missing, refreshKey)
  useEffect(() => {
    // A REST 404 can recover a lost removal frame for every index consumer too.
    if (record.missing && !missing) onFlightMissing?.(flightId)
  }, [record.missing, missing, flightId, onFlightMissing])
  const fetched = record.manifest
  const error = record.error
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
  useEffect(() => {
    if (activityRequest !== undefined) setStageActivityOpen('docs', true)
  }, [activityRequest, setStageActivityOpen])
  // R71/W1: one inline error line under the header — every header/run control
  // failure lands here instead of a silent `.catch(() => {})`.
  const actionPending = useRef(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [parallelSetupStarting, setParallelSetupStarting] = useState(false)
  // The existing Portify store remains the one owner for this long-running
  // workflow. Flight only contributes a start affordance and reads the same
  // pushed index/details every other Portify surface uses.
  const {
    workflows: portifyWorkflows = [],
    startPortify,
    loadPortify,
  } = usePortify()

  const [entryRefresh, setEntryRefresh] = useState(0)
  const refreshRecord = record.refresh
  const refetch = useCallback(() => {
    if (derivedFeature) setEntryRefresh((version) => version + 1)
    else refreshRecord()
  }, [derivedFeature, refreshRecord])
  useEffect(() => {
    if (!derivedFeature) return
    let current = true
    flightsApi.getFlightEntryOptions(derivedFeature).then((o) => {
      if (!current) return
      setDerivedPrefill({ repoPaths: o.prefill.repoPaths, description: o.prefill.description, env: o.prefill.env, evidence: o.evidence })
      if (o.flight) onNavigateFlight?.(o.flight.flightId)
    }).catch(() => { /* prefill is best-effort — the rail stands on its own */ })
    return () => { current = false }
  }, [derivedFeature, onNavigateFlight, refreshKey, docsRefreshKey, configRefreshKey, entryRefresh])

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
      attention: indexEntry.attention,
      ...(indexEntry.pauseReason ? { pauseReason: indexEntry.pauseReason } : {}),
      currentStage: indexEntry.currentStage,
      stages: (indexEntry.stages ?? []).map((s) => ({ key: s.key, status: s.status })),
      createdAt: indexEntry.createdAt,
      updatedAt: indexEntry.updatedAt,
      ...(indexEntry.endedAt ? { endedAt: indexEntry.endedAt } : {}),
    }
  }, [indexEntry, flightId])
  const flight = derivedManifest ?? (derivedFeature ? null : (record.missing ? null : fetched ?? seed))
  const coverage = useLiveCoverage(flight?.feature ?? derivedFeature ?? null)
  const coverageWarningText = coverageWarning(coverage.value?.freshness, coverage.confirmed, coverage.error)
  const stageCoverageWarning = coverageStageWarning(coverage.value?.freshness, coverage.confirmed, coverage.error)
  const coverageNextAction = coverage.value?.freshness?.nextAction
  const coverageRecovery = coverageWarningText && coverage.confirmed && coverageNextAction && coverage.value?.freshness?.state !== 'updating'
    ? { stage: coverageNextAction.stage, warning: coverageWarningText } : undefined
  const attentionRecovery = flight?.attention?.state === 'actionable' && flight.attention.remainingStage
    && flight.attention.remainingStage !== flight.attention.stage
    ? { stage: flight.attention.remainingStage, warning: flight.attention.reason } : coverageRecovery
  const seeded = !derivedManifest && !derivedFeature && !liveFlight && !fetched && seed != null
  /** The stage a "Continue" would enter at — first one without evidence. */
  const derivedEntry = derivedRail ? derivedEntryStage(derivedRail) : null

  /** Fire a flight control call: refetch on success, surface failure inline. */
  const act = useCallback((call: () => Promise<unknown>, onSuccess?: () => void): void => {
    if (actionPending.current) return
    actionPending.current = true
    setActionBusy(true)
    setActionError(null)
    Promise.resolve().then(call)
      .then(() => { (onSuccess ?? refetch)() })
      .catch((err: unknown) => setActionError(displayError(err)))
      .finally(() => { actionPending.current = false; setActionBusy(false) })
  }, [refetch])

  const startParallelSetup = useCallback((): void => {
    if (!flight || parallelSetupStarting) return
    setActionError(null)
    setParallelSetupStarting(true)
    startPortify({
      feature: flight.feature,
      ...(flight.opts.agent ? { agent: flight.opts.agent } : {}),
    })
      // The workspace push is the fast path; this authoritative read makes the
      // header swap and Activity attachment reliable even if that frame drops.
      .then((workflowId) => loadPortify(workflowId))
      .catch((err: unknown) => setActionError(displayError(err)))
      .finally(() => setParallelSetupStarting(false))
  }, [flight, loadPortify, parallelSetupStarting, startPortify])

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

  // Keep an explicit recalculation destination and the derived-to-recorded
  // redirect pinned. Ordinary flight switches still return to follow-mode.
  const seenFlightRef = useRef(flightId)
  useEffect(() => {
    const previous = seenFlightRef.current
    if (previous === flightId) return
    seenFlightRef.current = flightId
    if (onSelectStage && (activityRequest !== undefined || derivedFlightFeature(previous) !== null)) return
    setSelectedStage(null)
  }, [activityRequest, flightId, onSelectStage, setSelectedStage])

  // The rail hides conductor plumbing (R21) and merges run+heal into one user
  // step (R22) — selection and auto-pick both work on these visible rows.
  // Standalone work can restart a completed step. The rail and Follow must
  // read the same live activity as the chip, not just the saved flight verdict.
  const featureActivity = flight ? activity?.get(flight.feature) : undefined
  const activityRowKey = rowKeyForActivity(featureActivity)
  const featureCoverageJobs = coverageJobs.filter((job) => job.feature === flight?.feature)
  const activeCoverageJob = featureCoverageJobs.filter((job) => job.status === 'running')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || (a.kind === 'coverage' ? -1 : 1))[0]
  const coveragePhase = activeCoverageJob ? coverageJobStage(activeCoverageJob) : null
  const [followedCoverage, setFollowedCoverage] = useState<{ flightId: string; stage: FlightStageKey } | null>(null)
  useEffect(() => {
    if (coveragePhase) setFollowedCoverage({ flightId, stage: coveragePhase })
  }, [flightId, coveragePhase])
  // Keep the last generation stage in view when it settles. An explicit rail
  // selection still wins, and another live stage can take over follow-mode.
  const coverageLanding = followedCoverage?.flightId === flightId ? followedCoverage.stage : null
  const featureExternalHistory = flight ? externalHistory?.get(flight.feature) : undefined
  const featurePortify = flight
    ? portifyWorkflows.find((workflow) => workflow.feature === flight.feature && isActivePortify(workflow.status))
    : undefined
  // A verify run is a run in verify mode — the run row must read live for it
  // exactly as for a normal run.
  const runLive = featureActivity != null && ACTIVITY_STAGE[featureActivity.kind] === 'run'
  const railRows = useMemo(() => flight ? presentedFlightRows({
    feature: flight.feature,
    stages: flight.stages,
    activity: featureActivity,
    portifyWorkflows,
    coverageJobs,
    derivedStages: derivedStages?.get(flight.feature),
  }) : [], [flight, featureActivity, portifyWorkflows, coverageJobs, derivedStages])

  // Default the selected stage to the one that needs eyes: waiting → running →
  // first failed → the row that resumes next → last done. The user's explicit
  // pick wins. Once Report is ready, ordinary Parallel setup
  // progress stays in the rail while the main panel keeps the deliverable in
  // front. A checkpoint or failure still
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
    const attentionStage = flight?.attention && (flight.attention.state === 'actionable' || flight.attention.state === 'unavailable')
      && flight.attention.stage ? stageRowKey(flight.attention.stage) : null
    const pick =
      railRows.find((s) => s.key === attentionStage)
      ?? railRows.find((s) => s.status === 'waiting-for-approval')
      ?? railRows.find((s) => s.key === coveragePhase)
      ?? railRows.find((s) => s.status === 'running'
        && !(reportForeground && s.key === 'portify'))
      ?? railRows.find((s) => s.status === 'failed')
      ?? railRows.find((s) => s.key === coverageLanding)
      ?? reportForeground
      ?? railRows.find((s) => s.status === 'running')
      ?? railRows.find((s) => s.status === 'pending')
      ?? [...railRows].reverse().find((s) => s.status === 'done')
    return pick?.key ?? null
  }, [railRows, coveragePhase, coverageLanding, flight?.attention])
  const stageKey = selectedStage && railRows.some((stage) => stage.key === selectedStage)
    ? selectedStage
    : autoStage
  const row = railRows.find((s) => s.key === stageKey) ?? null
  const stagePresentations = new Map(railRows.map((s) => [s.key, presentStageStatus(
    s.status, s.key, s.key === activityRowKey ? featureActivity : undefined, undefined,
    { attention: flight?.attention, coverageWarning: stageCoverageWarning },
  )]))
  const stage = flight?.stages.find((s) => s.key === stageKey) ?? null
  // The pair-merged rows (run+heal, scaffold+env-capture, docs+prd-summary)
  // carry their folded companion so its facts/checkpoint/log surface too.
  const companionKey = stageKey ? STAGE_COMPANION[stageKey] : undefined
  const companionStage = (companionKey ? flight?.stages.find((s) => s.key === companionKey) : null) ?? null
  useEffect(() => {
    // Once generation settles, pin its result stage in the URL so refresh
    // restores the same result instead of jumping to an unrelated pending step.
    if (!coveragePhase && coverageLanding && selectedStage === null) setSelectedStage(coverageLanding)
  }, [coveragePhase, coverageLanding, selectedStage, setSelectedStage])

  // A read failure only blanks the view when there is nothing else to show.
  // With a pushed manifest in hand the record is NOT missing, and a transient
  // GET failure must not replace a live flight with "could not be loaded".
  if ((record.missing || error) && !flight) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-xs text-muted">
        <div>{record.missing ? 'This flight no longer exists.' : `Couldn't open this flight. ${error}`}</div>
        <button type="button" onClick={onBackToList} className="cl-button px-2.5 py-1">All flights</button>
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
  const suiteSetupStatus = railRows.find((candidate) => candidate.key === 'scaffold')?.status
  // Parallel setup is a sibling lane after Suite setup, not the next serial
  // Flight step. Selecting its pending row therefore makes its own start the
  // header primary. Once the workflow appears in the shared Portify store this
  // becomes false and the ordinary Continue/Pause control returns.
  const showParallelSetupStart = stageKey === 'portify'
    && row?.status === 'pending'
    && (suiteSetupStatus === 'done' || suiteSetupStatus === 'skipped')
    && featurePortify == null
    && externalWorkCheckpoint == null
    && flight.status !== 'waiting-for-approval'
    && externalMutationOwner == null
  const takeoverRequested = externalWorkCheckpoint != null
    && typeof (externalWorkCheckpoint.data as ExternalWorkCheckpointData | undefined)?.takeoverRequestedAt === 'string'
  const genuineCheckpoint = flight.status === 'waiting-for-approval' && !isExternalWorkPark(flight) && !externallyDriven
  const waitingChip = featureActivity?.waiting && !genuineCheckpoint ? featureChipState(flight, featureActivity) : null
  const runActivityChip = runLive && !genuineCheckpoint ? featureChipState(flight, featureActivity) : null
  const runPresentation = runActivityChip ? presentActivityRunStatus(featureActivity) : null
  const suiteActivityChip = activeCoverageJob
    ? ACTIVITY_CHIP[activeCoverageJob.kind === 'summary' ? 'condensing' : 'mapping']
    : runActivityChip ?? (externalSuiteWork && featureActivity && !genuineCheckpoint ? ACTIVITY_CHIP[featureActivity.kind] : null)
  const headerAttention = hasFlightAttention(flight.attention) ? flight.attention : undefined
  const headerAttentionStage = headerAttention?.stage
  const tone = flight.attention?.state === 'resolved' ? 'var(--text-secondary)' : waitingChip?.tone ?? runActivityChip?.tone ?? (agentHolding
    ? FLIGHT_STATUS_TONE['running']
    : suiteActivityChip?.tone ?? FLIGHT_STATUS_TONE[flight.status])
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
            onClick={flight.status === 'paused' && headerAttentionStage
              ? () => setSelectedStage(stageRowKey(headerAttentionStage)) : undefined}
            title={headerAttention ? `${headerAttention.title}. ${headerAttention.reason}`
              : waitingChip ? waitingChip.title : runActivityChip ? runActivityChip.title : agentHolding
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
            icon={runPresentation ? <StatusDot state={runPresentation.dot} pulse={runPresentation.pulse} className="shrink-0" /> : waitingChip ? <StatusDot state={featureActivity?.waiting?.kind === 'queued' ? 'idle' : 'warning'} className="shrink-0" /> : flight.status === 'running' || agentHolding || suiteActivityChip ? <StatusDot state="running" className="shrink-0" /> : undefined}
            label={waitingChip ? capitalizeFirst(waitingChip.label) : runActivityChip ? capitalizeFirst(runActivityChip.label) : agentHolding
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
              className="cl-button-primary px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-45"
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
        {isActiveFlightStatus(flight.status) && !externalWorkCheckpoint && !showParallelSetupStart && (
          <DisabledControlTooltip>
            <button
              type="button"
              data-testid="flight-pause"
              onClick={() => act(() => flightsApi.pauseFlight(flightId))}
              // Nothing here can stop work running inside the user's own agent:
              // pausing from this side would park the flight while the agent kept
              // going, and its result would then be discarded as stale. Kept
              // visible and disabled for genuine external decisions so the
              // tooltip names where it moved. During an external-work hand-off,
              // the header's takeover action replaces Pause entirely: that is
              // the only safe way to transfer ownership without discarding the
              // external agent's eventual result.
              disabled={externalMutationOwner != null}
              className="cl-button px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-45"
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
            exist. An incomplete suite reuses the Continue menu through its
            feature-scoped start path: Resume mints the record directly, while
            From a step opens the deliberate picker. An all-done suite keeps
            Fly again, whose fresh-start launcher may change its inputs.
            The ⋯ menu is NOT record-scoped and stays: its one action deletes the
            SUITE (folder + history) through the feature-scoped API, and a
            derived flight only exists because that folder does. Hiding it with
            the rest denied a perfectly valid action on every suite that was set
            up outside the conductor. */}
        {showParallelSetupStart ? (
          <>
            <button
              type="button"
              data-testid="flight-run-parallel-setup"
              onClick={startParallelSetup}
              disabled={parallelSetupStarting}
              className="cl-button-primary px-2.5 py-1 text-xs disabled:cursor-wait disabled:opacity-65"
              title="Start Parallel setup now. The remaining Flight can continue at the same time."
            >
              {parallelSetupStarting ? 'Starting…' : 'Run Parallel Setup'}
            </button>
            <FlightMenu
              flight={flight}
              derived={derivedFeature != null}
              onAction={act}
              onDeleted={onBackToList}
              externalMutationOwner={externalMutationOwner}
            />
          </>
        ) : derivedFeature ? (
          <>
            {derivedEntry || coverageRecovery ? (!activeCoverageJob && (
              <ContinueMenu
                flight={flight}
                onAction={act}
                onStartFlight={onStartFlight}
                externalMutationOwner={externalMutationOwner}
                recordlessEntry={derivedEntry ?? coverageRecovery!.stage}
                coverageRecovery={coverageRecovery}
              />
            )) : (
              <DisabledControlTooltip>
                <button
                  type="button"
                  data-testid="derived-conduct"
                  onClick={() => onStartFlight?.(derivedFeature, 'fresh', null)}
                  disabled={externalMutationOwner != null}
                  className="cl-button-primary px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-45"
                  title={externalMutationOwner
                    ? externalMutationTooltip(externalMutationOwner, 'start or continue a flight')
                    : 'Every step is done — start a fresh flight to fly it again'}
                >
                  Fly again
                </button>
              </DisabledControlTooltip>
            )}
            <FlightMenu flight={flight} derived onAction={act} onDeleted={onBackToList} externalMutationOwner={externalMutationOwner} />
          </>
        ) : (
          <>
            {evalStage?.status === 'done' && (
              <DownloadEvaluationAction flight={flight} stage={evalStage} testId="flight-primary-download" primary />
            )}
            {flight.attention?.state === 'unavailable' && <button type="button" className="cl-button px-2.5 py-1 text-xs" onClick={refetch}>Check again</button>}
            {flight.status === 'paused' && !activeCoverageJob && flight.attention?.state === 'actionable' && (
              <ContinueMenu flight={flight} onAction={act} onStartFlight={onStartFlight}
                externalMutationOwner={externalMutationOwner} coverageRecovery={attentionRecovery} inline busy={actionBusy} />
            )}
            {!headerAttention && !activeCoverageJob && (flight.status === 'paused' || flight.status === 'failed' || flight.status === 'aborted' || flight.status === 'done') && (
              <ContinueMenu flight={flight} onAction={act} onStartFlight={onStartFlight} externalMutationOwner={externalMutationOwner}
                coverageRecovery={coverageRecovery} />
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
          <button type="button" onClick={() => setActionError(null)} className="cl-button min-h-6 shrink-0 px-2 py-0.5">Dismiss</button>
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
        onToggleAutopilot={derivedFeature || seeded ? undefined : (next) => act(() => flightsApi.setFlightAutopilot(flight.flightId, next))}
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
          {/* R72: follow-mode is a real bordered `cl-button`, not a bare text
              link, so it reads as clickable. ONE element in both states so
              nothing jumps — "● Follow" pressed while auto-following, "↺ Follow"
              once a manual pick parks the selection. Enabled in both: clicking
              while already following is a harmless no-op. That no-op is why the
              pressed look stays quiet — the default state, where the click does
              nothing, must not be the loudest thing in the rail. It is the
              selected grey plus ONE sky element, the dot; text and border stay
              neutral, and `py-0.5` keeps the chip from towering over the title. */}
          {/* "Steps" TITLES the list instead of opening a band of its own. The
              rail's section bands (Setup, Verification cycle, …) carry the rubric
              + dashed rule, so a ruled "Steps" stacked straight onto "Setup" read
              as an empty band. One tone up and unruled, it sits above them as
              their parent. `mb-1.5` still keeps air between the title and a first
              row that opens no section (the pre-flight check). */}
          <div className="mb-1.5 flex items-center gap-2 px-2">
            {/* "Steps", not "Stages": every tooltip and card in the pane says
                "step" — one word for one thing. */}
            <span className="cl-rubric-strong shrink-0">
              Steps
            </span>
            <Tooltip label={selectedStage === null
              ? 'Following whichever step needs you'
              : 'Go back to following the step that needs you'}>
              <button
                type="button"
                data-testid={selectedStage === null ? 'rail-following' : 'rail-resume-follow'}
                aria-pressed={selectedStage === null}
                onClick={() => setSelectedStage(null)}
                className="cl-button ml-auto flex shrink-0 items-center gap-1 px-1.5 py-0.5 leading-none"
                style={selectedStage === null ? { background: 'var(--bg-selected)' } : undefined}
              >
                <span aria-hidden="true" className="text-[9px]" style={selectedStage === null ? { color: 'var(--accent)' } : undefined}>
                  {selectedStage === null ? '●' : '↺'}
                </span>
                Follow
              </button>
            </Tooltip>
          </div>
          {railRows.map((s) => {
            const section = FLIGHT_STAGE_SECTIONS.find((group) => group.keys[0] === s.key)
            const selected = s.key === stageKey
            const presentation = stagePresentations.get(s.key)!
            const t = presentation.tone
            // A merged row's duration sums its primary + folded companion
            // (run→heal, scaffold→env-capture, docs→prd-summary) — R61. Work
            // time, not wall clock: checkpoint parks and pauses don't count.
            const primary = flight.stages.find((st) => st.key === s.key)
            const folded = flight.stages.find((st) => st.key === STAGE_COMPANION[s.key])
            const duration = formatStageDuration(primary, folded)
            // One custom tooltip owns the rail row. Status remains visible in its
            // icon and the selected-stage pane; folding it into the short stage
            // explanation made the hover copy needlessly dense.
            const tooltip = presentation.title ?? STAGE_BLURB[s.key]
            return (
              <Fragment key={s.key}>
                {section && (
                  <div data-testid={`flight-rail-section-${section.id}`} className="mb-1 mt-2 px-2">
                    <div className="flex items-center gap-2">
                      <span className="cl-rubric shrink-0">{section.label}</span>
                      <span className="h-px flex-1 border-t border-dashed border-line" />
                    </div>
                  </div>
                )}
                <Tooltip label={tooltip}><button
                  type="button"
                  data-testid={`stage-rail-${s.key}`}
                  aria-current={selected ? 'true' : undefined}
                  aria-label={`${s.label} — ${presentation.title ?? presentation.label}`}
                  onClick={() => setSelectedStage(s.key)}
                  className={`cl-hover-row flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors${selected ? ' bg-selected' : ''}`}
                >
                  {/* Status hue stays a computed token string (one source of
                      truth in stageStatusTone), so this one keeps `color`. */}
                  <span className="w-3 shrink-0 text-center font-semibold" style={{ color: t }} aria-hidden="true">
                    <StageStatusIcon presentation={presentation} />
                  </span>
                  <span className={`min-w-0 flex-1 truncate${s.status === 'pending' ? ' text-muted' : ''}`}>
                    {s.label}
                  </span>
                  {/* The amber wash carries the tone; the text keeps the
                      rubric's baked-in muted ink (a `text-*` utility beside
                      `.cl-rubric` is dead). */}
                  {s.note && (
                    <span
                      data-testid={`stage-rail-note-${s.key}`}
                      className="cl-rubric shrink-0 rounded bg-warning/12 px-1"
                    >
                      {s.note}
                    </span>
                  )}
                  {duration && s.status !== 'running' && (
                    <span className="shrink-0 text-[10px] text-muted font-mono">
                      {duration}
                    </span>
                  )}
                  {s.key === activityRowKey && (featureActivity?.runId || featureActivity?.waiting) && <span className="shrink-0 text-[10px]" style={{ color: t }}>{presentation.label}</span>}
                  {presentation.dot && <StatusDot state={presentation.dot} pulse={presentation.pulse} className="shrink-0" />}
                </button></Tooltip>
              </Fragment>
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
              presentation={stagePresentations.get(row.key)!}
              stage={stage}
              companion={companionStage}
              runLive={runLive}
              activePortifyWorkflowId={featurePortify?.workflowId}
              activity={featureActivity}
              externalHistory={featureExternalHistory}
              coverageJobs={featureCoverageJobs}
              activityOpen={activityOpenByFlight[flightId]?.[stage.key]}
              onActivityOpenChange={(open) => setStageActivityOpen(stage.key, open)}
              {...(onOpenLog ? {
                openLogId: log ?? null,
                // A log entry names a row of THIS stage, so opening one in
                // follow-mode pins the stage too — otherwise a refresh could
                // auto-pick a different stage and lose the entry.
                onOpenLogChange: (id: string | null) => {
                  if (id && selectedStage === null) setSelectedStage(stage.key)
                  onOpenLog(id)
                },
              } : {})}
              externalMutationOwner={externalMutationOwner}
              onResponded={refetch}
              onActionError={setActionError}
              onStartFlight={onStartFlight}
              onOpenConfig={onOpenConfig}
              onOpenSpecReview={onOpenSpecReview}
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
  // Requirements drills to the same ledger — that's where the distilled
  // requirements become browsable rows. Gated on the folded prd-summary
  // companion, NOT on the docs row: the docs stage is `done` the moment its
  // source docs are approved, and offering a ledger then opens an empty one.
  if (stage.key === 'docs' && drill.onOpenCoverage && companion?.status === 'done') {
    const open = drill.onOpenCoverage
    return { label: 'Test coverage →', onClick: () => open(flight.feature) }
  }
  if (stage.key === 'specs-coverage' && drill.onOpenCoverage && stage.status !== 'pending') {
    const open = drill.onOpenCoverage
    return { label: 'Test coverage →', onClick: () => open(flight.feature) }
  }
  // Flight owns the Parallel-readiness workflow, including live work, review
  // and save. This drill is only a supporting-config lens: the Ports tab holds
  // the slot ↔ env-var map and remove control, then routes back here for work.
  // Unlocks once the stage has been touched at all — settled, skipped, or
  // parked. `pending` alone isn't "never ran": an interrupted stage reverts to
  // pending and keeps its startedAt, and that's exactly when you want the tab.
  if (stage.key === 'portify' && onOpenConfig && (stage.status !== 'pending' || stage.startedAt != null)) {
    return { label: 'Port settings →', onClick: () => onOpenConfig(flight.feature, 'ports') }
  }
  return null
}
