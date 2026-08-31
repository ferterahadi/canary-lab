import type { ExternalWorkCheckpointData, FlightManifest, FlightStage, FlightStageKey } from '@/shared/api/client'
import type { AgentSessionSegmentSource, AgentSessionSource, ExternalSessionActivity } from '@/shared/ui/AgentSessionView'
import { clientLabel, type ExternalClientKind } from '@/shared/ui/external-client-branding'
import { TestRunPanel, type RunStageEvidence } from './TestRunPanel'
import { FeatureSetupPanel, FlightDocsPanel, RepoScanPanel, RequirementsFork } from './FlightStagePanels'
import type { FlightLauncherIntent } from '@/shared/state/nav-state'
import type { ConfigTab } from '@/shared/lib/workspace-view-state'
import { evaluationTaskId, FactsGrid, StageColumn, StageStatusChip, portifyWorkflowId, specsCoverageProgress, stageFacts, stageRowKey, stageStateLine, type StageRailRow } from './stage-meta'
import { useEvaluationExports } from '@/features/evaluation'
import { PortifyWorkflowControls } from '@/features/portify'
import { CheckpointControls } from './CheckpointControls'
import { AGENT_STAGE_DIRS, stageDrillThrough } from './FlightDetail'
import type { FlightDrillThroughs } from './FlightPage'
import { StageErrorPanel, StagePausedPanel, pausedResumeKind } from './StageStatePanels'
import { EXTERNAL_WORK_COPY, externalMutationTooltip, isExternallyDriven, type ExternalMutationOwner } from '../lib/external-work'
import { ACTIVITY_STAGE, type ExternalWorkTrace, type FeatureActivity, type StageExternalHistory } from '../state/feature-activity'
import { Chip } from '@/shared/ui/StatusChip'
import { flightRowModelChips } from '@shared/flights/stage-models'
import { flightStageLabel } from '@shared/flights/stage-labels'
import { ModelPlanPopover } from './ModelPlanPopover'
import { SkeletonPanel, awaitingFor } from '@/shared/ui/Skeleton'
import { DisabledControlTooltip } from '@/shared/ui/Tooltip'
import { useStageBandData } from './use-stage-band-data'
import {
  AllReportsPanel,
  BootCheckPanel,
  CoverageCompositionPanel,
  DoubleBootPanel,
  EvaluationDeliverablePanel,
  OverlayPanel,
} from './StageEvidencePanels'
import { SpecsPassTimeline, StageActivityRail, truncate } from './StageActivity'
import { presentedStageStatus } from './stage-metrics'

export { AgentBlock, SpecsPassTimeline, StageActivityRail, specsPhaseSub, truncate } from './StageActivity'

// One uniform stage template (R20). Every stage renders the SAME skeleton —
// nothing stage-shaped leaks into the layout:
//   1. label + status chip + the one primary affordance (drill-through)
//   2. state line — one plain sentence
//   3. facts — the 2–4 things the user cares about at this stage (FactsGrid)
//   4. checkpoint / error, when the stage needs the user
//   5. the activity band (R66): ONE chronological story — the conductor's
//      tagged lines, the agent timeline (AgentSessionView) embedded where the
//      agent worked, the wrap-up lines after. Expanded while the stage works;
//      one "▸ View activity" disclosure once it settles.

/** Parallel readiness keeps its evidence (the double boot, the port changes) in
 *  the workflow record, and its transcript wherever the agent CLI wrote it. The
 *  two come apart routinely — an external-producer workflow leaves the
 *  transcript in the user's own client, and a cleaned agent history leaves none
 *  at all — so the generic "nothing ran here" would contradict the proof panels
 *  directly above the rail. */
const PORTIFY_NO_TRANSCRIPT = {
  title: 'Nothing to replay here',
  body: 'What the port work produced is the side-by-side boot and the port changes above.',
}

/** A standalone external task has no Canary-owned transcript. Translate its
 *  durable producer record into one compact row on the shared Activity rail. */
export function externalSessionActivity(
  trace: ExternalWorkTrace,
  flightSession?: FlightManifest['externalAgentSession'],
): ExternalSessionActivity {
  // Older Flight-owned jobs persisted `flight:<id>` instead of the caller's
  // real session. Prefer the Flight-level identity for those legacy traces;
  // keep an independently started task's own identity intact.
  const legacyFlightId = trace.sessionId?.startsWith('flight:') === true
  const inheritsFlightSession = trace.sessionId === undefined
    || legacyFlightId
    || trace.sessionId === flightSession?.sessionId
  const clientKind = externalClientKind(
    trace.clientKind === undefined || trace.clientKind === 'other'
      ? inheritsFlightSession ? flightSession?.clientKind : trace.clientKind
      : trace.clientKind,
  )
  const sessionId = legacyFlightId
    ? flightSession?.sessionId
    : trace.sessionId ?? flightSession?.sessionId
  const client = clientLabel(clientKind, 'external agent')
  const owner = clientKind === 'other' ? 'your external agent session' : `your ${client} session`
  const fileCount = trace.itemCount != null
    ? ` · ${trace.itemCount} file${trace.itemCount === 1 ? '' : 's'} applied`
    : ''
  let message: string
  if (trace.status === 'running') {
    message = `Work is continuing in ${owner}.`
  } else if (trace.status === 'ready') {
    message = `The result is ready in ${owner}.`
  } else if (trace.status === 'done') {
    message = `Completed outside Canary Lab${fileCount}.`
  } else if (trace.status === 'failed') {
    message = `Stopped with an error in ${owner}.`
  } else {
    message = `Stopped in ${owner}.`
  }
  return {
    clientKind,
    ...(sessionId ? { sessionId } : {}),
    status: trace.status,
    message,
    startedAt: trace.startedAt,
    ...(trace.status === 'running' ? {} : { endedAt: trace.updatedAt }),
    ...(trace.conversationName
      ? { conversationName: trace.conversationName }
      : inheritsFlightSession && flightSession?.conversationName
        ? { conversationName: flightSession.conversationName }
        : {}),
    ...(trace.sessionUrl
      ? { sessionUrl: trace.sessionUrl }
      : inheritsFlightSession && flightSession?.sessionUrl
        ? { sessionUrl: flightSession.sessionUrl }
        : {}),
  }
}

function externalClientKind(clientKind: string | undefined): ExternalClientKind {
  const normalized = clientKind?.toLowerCase() ?? ''
  if (normalized === 'claude-pty' || (normalized.includes('claude') && normalized.includes('pty'))) return 'claude-pty'
  if (normalized === 'codex-pty' || (normalized.includes('codex') && normalized.includes('pty'))) return 'codex-pty'
  if (normalized.includes('claude')) return 'claude'
  if (normalized.includes('codex')) return 'codex'
  return 'other'
}

function stageExternalHistory(
  history: Partial<Record<FlightStageKey, StageExternalHistory>> | undefined,
  stage: FlightStage,
  companion: FlightStage | null,
): StageExternalHistory {
  const stageHistories = [history?.[stage.key], companion ? history?.[companion.key] : undefined]
    .filter((entry): entry is StageExternalHistory => entry != null)
  const traces = stageHistories
    .flatMap((entry) => entry.traces)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.updatedAt.localeCompare(b.updatedAt))
  const current = stageHistories
    .flatMap((entry) => entry.current ? [entry.current] : [])
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return { traces, ...(current ? { current } : {}) }
}

/** The folded Requirements row owns two sequential agent stages. New records
 *  carry immutable session refs; the legacy fallback follows the two stable
 *  sidecars so Flights recorded before that provenance was added still replay
 *  both transcripts. */
function requirementSessionSources({
  flightId,
  docs,
  summary,
  externalOwnsCurrent,
  allowLegacy,
}: {
  flightId: string
  docs: FlightStage
  summary: FlightStage | null
  externalOwnsCurrent: boolean
  allowLegacy: boolean
}): AgentSessionSegmentSource[] {
  if (docs.key !== 'docs' || summary?.key !== 'prd-summary') return []

  const recorded = (owner: FlightStage): AgentSessionSegmentSource[] =>
    (owner.agentSessions ?? []).map((session, index, sessions) => ({
      label: session.label,
      startedAt: session.startedAt,
      source: {
        kind: 'flight',
        flightId,
        stage: session.sidecar,
        live: owner.status === 'running'
          && !externalOwnsCurrent
          && index === sessions.length - 1,
      },
    }))

  const docsRecorded = recorded(docs)
  const summaryRecorded = recorded(summary)
  const docsAgentLine = /^\[docs(?:@([^\]]+))?\] agent attempt \([^)]+\) — .*…$/m.exec(docs.log ?? '')
  const docsSources = docsRecorded.length > 0
    ? docsRecorded
    : allowLegacy && docsAgentLine
      ? [{
          label: `Pass 1 · ${flightStageLabel('docs')}`,
          startedAt: docsAgentLine[1] ?? docs.startedAt,
          source: {
            kind: 'flight' as const,
            flightId,
            stage: 'docs',
            live: docs.status === 'running' && !externalOwnsCurrent,
          },
        }]
      : []
  const summaryEvidence = asRecord(summary.evidence)
  const legacySummaryRan = allowLegacy
    && (summary.status === 'running'
      || summary.status === 'failed'
      || (summary.status === 'done' && summaryEvidence?.reused !== true))
  const pass = Math.max(1, docs.agentSessions?.length ?? 0)
  const summarySources = summaryRecorded.length > 0
    ? summaryRecorded
    : legacySummaryRan
      ? [{
          label: `Pass ${pass} · ${flightStageLabel('prd-summary')}`,
          startedAt: summary.startedAt,
          source: {
            kind: 'flight' as const,
            flightId,
            stage: 'prd-summary',
            live: summary.status === 'running' && !externalOwnsCurrent,
          },
        }]
      : []
  return [...docsSources, ...summarySources]
}

export function StageDetail({
  flightId,
  flight,
  row,
  stage,
  companion,
  runLive,
  activeRunId,
  activePortifyWorkflowId,
  activity,
  externalHistory,
  activityOpen,
  onActivityOpenChange,
  externalMutationOwner,
  onResponded,
  onActionError,
  onStartFlight,
  onOpenConfig,
  configRefreshKey,
  docsRefreshKey,
  drill,
}: {
  flightId: string
  flight: FlightManifest
  row: StageRailRow
  stage: FlightStage
  /** The folded half of a pair-merged row (heal / env-capture / prd-summary). */
  companion: FlightStage | null
  /** A run for this feature is live right now (R64) — the run row polls. */
  runLive?: boolean
  /** Run identity supplied by the live run stream for a derived Flight. Real
   *  flight records keep their own stage/link identity instead. */
  activeRunId?: string
  /** Portify's own live-store identity. Unlike the one-verb feature Activity
   *  map, this survives when a simultaneous test run is the louder activity. */
  activePortifyWorkflowId?: string
  /** This feature's live verb (the one activity map App derives) — drives the
   *  compact external-session Activity row on the stage the job belongs to. */
  activity?: FeatureActivity
  /** Durable external producer records for this feature, keyed by stage. */
  externalHistory?: Partial<Record<FlightStageKey, StageExternalHistory>>
  /** The stage's remembered Activity disclosure choice. Undefined preserves
   *  the normal default: open while live, collapsed otherwise. */
  activityOpen?: boolean
  onActivityOpenChange: (open: boolean) => void
  /** Present while mutations belong to the Claude/Codex session. */
  externalMutationOwner?: ExternalMutationOwner
  onResponded: () => void
  /** R71/W1: run-control failures surface on the header's inline error line. */
  onActionError?: (msg: string) => void
  /** R75: the Repo scan panel's "Change…" → launcher handoff. */
  onStartFlight?: (feature: string, intent?: FlightLauncherIntent, fromStage?: FlightStageKey | null) => void
  onOpenConfig?: (feature: string, tab?: ConfigTab) => void
  configRefreshKey?: number
  docsRefreshKey?: number
  drill: FlightDrillThroughs
}) {
  // R27: the specs↔coverage loop runs TWO agents per pass — the authoring
  // agent (sidecar `specs-coverage`) and the mapping agent (`coverage-map`).
  // The live view follows whichever half of the loop is working now.
  const loopProgress = specsCoverageProgress(stage)
  const agentDir =
    loopProgress && stage.status === 'running' && loopProgress.phase === 'mapping'
      ? 'coverage-map'
      // The merged Requirements row has TWO possible agents: the docs
      // collector (R74) while its own half is open, then the folded
      // prd-summary's distiller once docs settle.
      : stage.key === 'docs' && (stage.status === 'running' || stage.status === 'waiting-for-approval')
        ? 'docs'
        : AGENT_STAGE_DIRS[stage.key] ?? (companion ? AGENT_STAGE_DIRS[companion.key] : undefined)
  const runMerged = stage.key === 'run'
  const live = row.status === 'running'
  const settled = row.status === 'done' || row.status === 'failed'
  // R83: the pane keeps its settled layout in every state. Missing slots stay
  // mounted after settle too, but change to the static unavailable treatment so
  // the stable shape never promises that more evidence is still coming.
  const awaiting = awaitingFor(row.status, live)
  const externalStage = stageExternalHistory(externalHistory, stage, companion)
  const externalTrace = externalStage.current
  // Derived Flights learn external task identity from the task's own live
  // stream before the workspace evidence probe catches up. Feed that identity
  // through the normal stage-band path so the result lands without a refresh.
  const livePortifyId = activePortifyWorkflowId
    ?? (activity?.kind === 'portifying'
      ? activity.workflowId
      : externalTrace?.kind === 'portifying'
        ? externalTrace.resourceId
        : undefined)
  const dataStage: FlightStage = stage.key === 'portify' && livePortifyId
    ? { ...stage, evidence: { ...(stage.evidence ?? {}), workflowId: livePortifyId } }
    : stage
  // The Evaluation Report has two task roles. Its recorded task remains the
  // pinned deliverable (run · report mode · archive name), while Activity may
  // follow a newer live export for the same suite.
  const recordedEvalTaskId = evaluationTaskId(stage, flight)
  const externalEvalTaskId = externalTrace?.kind === 'exporting' ? externalTrace.resourceId : undefined
  const deliverableEvalTaskId = recordedEvalTaskId ?? externalEvalTaskId
  const { tasks: evaluationTasks, taskById } = useEvaluationExports()
  // A standalone export can run after this stage already has a completed,
  // pinned deliverable. Keep that completed task in the facts/cards, but let
  // Activity follow the newest live task so "building…" can never sit above a
  // replay of an older raw report (or the false "No activity recorded").
  const liveEvalTask = stage.key === 'evaluation-export'
    ? evaluationTasks.find((task) => task.feature === flight.feature && task.status === 'running') ?? null
    : null
  const activityEvalTask = (externalEvalTaskId ? taskById(externalEvalTaskId) : null)
    ?? liveEvalTask
    ?? (deliverableEvalTaskId ? taskById(deliverableEvalTaskId) : null)
  // Sources outside the flight record (ledger, boot run, portify workflow,
  // config, envsets, docs) — resolved for the VISIBLE stage only.
  const band = useStageBandData(
    flight,
    dataStage,
    companion,
    deliverableEvalTaskId ? taskById(deliverableEvalTaskId) : null,
  )
  // The same hold, for cards the band's own sources feed. A first read outranks
  // the stage state because a value really is on its way; once it resolves empty,
  // the stage's own idle, failed, or unavailable treatment takes over.
  const awaitingData = band.pending ? 'live' : awaiting
  const facts = stageFacts(dataStage, flight, companion ?? undefined, band)
  // Read off the ROW key, so the merged pairs report their companion's spawns
  // too (Test run carries heal, Requirements carries the summary distiller).
  const modelChips = flightRowModelChips(row.key, flight.opts.models)
  const drillThrough = stageDrillThrough(dataStage, flight, drill, companion, onOpenConfig)
  const runId = runMerged
    ? (activeRunId ?? ((stage.evidence as Record<string, unknown> | undefined)?.runId as string | undefined) ?? flight.links?.runId)
    : undefined
  const pausedKind = pausedResumeKind(stage, flight, companion)
  const pausedNotice = pausedKind ? <StagePausedPanel kind={pausedKind} /> : null
  // The merged Run stage renders as the Test Run hero (TestRunPanel) — it owns
  // the run detail poll, so StageDetail no longer fetches it here (R80). The
  // hero renders from this evidence immediately (before its first poll) and
  // enriches from the live run detail; healEnd rides the run stage's evidence.
  const runEv = (stage.evidence ?? {}) as Record<string, unknown>
  const runCev = (companion?.evidence ?? {}) as Record<string, unknown>
  const runEvidence: RunStageEvidence = {
    runId,
    status: typeof runEv.status === 'string' ? runEv.status : undefined,
    healCycles: typeof runEv.healCycles === 'number'
      ? runEv.healCycles
      : typeof runCev.healCycles === 'number' ? runCev.healCycles : undefined,
    healEnd: runEv.healEnd as RunStageEvidence['healEnd'],
  }
  // A pair row surfaces whichever half is parked on a checkpoint (the
  // missing-env checkpoint lives on the folded env-capture, run-failed on run).
  const checkpointStage =
    stage.status === 'waiting-for-approval' ? stage
    : companion?.status === 'waiting-for-approval' ? companion
    : null
  const error = stage.error ?? companion?.error
  // Detail travels with whichever half's error is showing.
  const errorDetail = stage.error != null ? stage.errorDetail : companion?.errorDetail
  const combinedLog = [stage.log, companion?.log].filter(Boolean).join('')
  const activityOnThisRow = activity?.external === true
    && stageRowKey(ACTIVITY_STAGE[activity.kind]) === stage.key
  const flightHandOff = isExternallyDriven(flight)
    && checkpointStage?.checkpoint?.kind === 'external-work'
  const handOffData = flightHandOff
    ? checkpointStage?.checkpoint?.data as ExternalWorkCheckpointData | undefined
    : undefined
  const takeoverRequested = typeof handOffData?.takeoverRequestedAt === 'string'
  const handOffMessage = takeoverRequested
    ? `${EXTERNAL_WORK_COPY.takeover.requestedTitle}. ${EXTERNAL_WORK_COPY.takeover.requestedBody}`
    : handOffData?.lastRejection === 'stale_submission'
      ? EXTERNAL_WORK_COPY.lateResultNote
      : undefined
  const historicalExternalSessions = externalStage.traces.map((trace) =>
    externalSessionActivity(trace, flight.externalAgentSession),
  )
  // The live activity map can update before the durable resource list. Keep a
  // temporary row during that gap, but drop it once the persisted running trace
  // arrives so one external task never appears twice.
  const liveExternalFallback: ExternalSessionActivity | undefined =
    (activityOnThisRow || flightHandOff)
      && !historicalExternalSessions.some((session) => session.status === 'running')
      ? {
          clientKind: externalClientKind(flight.externalAgentSession?.clientKind),
          ...(flight.externalAgentSession?.sessionId
            ? { sessionId: flight.externalAgentSession.sessionId }
            : {}),
          status: 'running',
          message: handOffMessage ?? 'Work is continuing in your external agent session.',
          ...(flight.externalAgentSession?.conversationName
            ? { conversationName: flight.externalAgentSession.conversationName }
            : {}),
          ...(flight.externalAgentSession?.sessionUrl
            ? { sessionUrl: flight.externalAgentSession.sessionUrl }
            : {}),
        }
      : undefined
  const baseExternalSessions = liveExternalFallback
    ? [...historicalExternalSessions, liveExternalFallback]
    : historicalExternalSessions
  // The durable trace can arrive before the takeover request. Override only
  // its live row so the serialized hand-off state replaces the stale generic
  // "work is continuing" copy without rewriting completed provenance.
  const externalSessions = handOffMessage
    ? baseExternalSessions.map((session) => session.status === 'running'
      ? { ...session, message: handOffMessage }
      : session)
    : baseExternalSessions

  // R66: every stage's activity is the same rail. Resolve its one agent source
  // (if any): agent stages tail their flight session; the Evaluation Report
  // tails its export task (kind:'evaluation' — a localized rewrite streams a
  // timeline, a raw export has none and shows only its system rows). Agentless
  // stages pass no source and render system rows alone.
  // Portify's agent lives under the WORKFLOW dir (logs/portify/<wf>), not a
  // flight sidecar — tail it through the Portify workflow source, keyed by the
  // id the adapter pins as live progress. Without this the
  // stage's longest phase (the agent editing) shows an empty rail.
  const portifyId = portifyWorkflowId(dataStage)
  const recordedPortifyId = portifyWorkflowId(stage)
  const flightOwnsPortify = portifyId != null
    && recordedPortifyId === portifyId
    && (flight.status === 'running' || checkpointStage?.checkpoint?.kind === 'portify-apply')
  const standalonePortifyActionable = band.portify?.status === 'ready-to-save'
    || band.portify?.status === 'planning'
    || band.portify?.status === 'editing'
    || band.portify?.status === 'verifying'
  const evaluationLive = activityEvalTask?.status === 'running'
  const localActivitySource: AgentSessionSource | undefined =
    activityEvalTask?.sessionRef
      ? { kind: 'evaluation', taskId: activityEvalTask.taskId, live: evaluationLive }
    : portifyId ? { kind: 'portify', workflowId: portifyId, live }
    : agentDir ? { kind: 'flight', flightId, stage: agentDir, live }
    : undefined
  // External producers have no Canary-owned current transcript. Historical
  // internal sessions stay on the rail, but none of them may present as live.
  const externalOwnsCurrent = externalTrace !== undefined || liveExternalFallback !== undefined
  const recordedSessionSources: AgentSessionSegmentSource[] = (stage.agentSessions ?? []).map((session, index, sessions) => ({
    label: session.label,
    startedAt: session.startedAt,
    source: {
      kind: 'flight',
      flightId,
      stage: session.sidecar,
      live: live
        && !externalOwnsCurrent
        && index === sessions.length - 1
        && loopProgress?.phase === session.phase
        && loopProgress?.pass === session.pass,
    },
  }))
  const foldedRequirementSessions = requirementSessionSources({
    flightId,
    docs: stage,
    summary: companion,
    externalOwnsCurrent,
    // The legacy fallback guesses from stage evidence because old manifests
    // did not persist session refs. Only internal Flights can safely make that
    // inference; a settled external Flight no longer satisfies
    // isExternallyDriven(), but still has no Canary-owned transcript.
    allowLegacy: flight.opts.stageProducer !== 'external',
  })
  const sessionSources = foldedRequirementSessions.length > 0
    ? foldedRequirementSessions
    : recordedSessionSources
  // Suppress the legacy local source entirely so its generic live tail cannot
  // add a second spinner under the external-session row or replay an older
  // internal session as current.
  const activitySource = sessionSources.length > 0 || externalOwnsCurrent ? undefined : localActivitySource

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* R66: header, facts and stage panels scroll here; the activity band
          below fills the rest of the pane so a long transcript scrolls in
          place instead of the whole stage view running off the bottom. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
      {/* R85: the chip + actions share a top edge with the first card instead of
          sitting on a row of their own above it. The cards are capped at
          STAGE_COLUMN (92ch) while the pane is wider, so the leftover width to
          their right was empty anyway — the old dedicated row spent 36px of
          vertical space to put a chip in it, pushing "At a glance" that much
          further from the stage rail it belongs to.
          `order-last` paints the column on the right while keeping the chip and
          its actions FIRST in DOM (and so in tab order), where they read as the
          stage's header. `items-start` keeps the actions at the top rather than
          centring them against a pane-tall card stack. */}
      <div className="flex items-start gap-2">
      {/* min-h-6 (=the .cl-button height) locks the actions row height, so
          neither the chip nor an action button drops when a stage carries one
          (Advanced setup, drill-through, download) versus the plain chip-only
          stages. */}
      <div data-testid="stage-actions" className="order-last flex min-h-6 shrink-0 items-center gap-2">
        {/* The models this step's agents were pinned to — a passive fact, so it
            sits ahead of the status chip and the action buttons rather than
            among them. A step left on the agent default shows nothing at all,
            which is what makes the chip mean "this one was deliberately tuned".
            ONE chip that opens the plan, not one chip per spawn: a bare
            `opus · high` named a model with no subject, and a merged row put
            two such subjectless chips side by side. Spelling the subject inline
            instead just traded that for a header full of prose. The panel is
            the strip's, via ModelPlanPopover — same spawn → knobs rows, scoped
            to this step. */}
        {modelChips.length > 0 && (
          <ModelPlanPopover
            /* The stage's chips live in a right-aligned cluster; a left-anchored
               panel would hang off the pane. */
            align="right"
            panelTestId="stage-models-plan"
            rows={modelChips.map((chip) => ({ key: chip.stage, label: chip.label, value: chip.value }))}
          >
            {({ open, toggle }) => (
              <Chip
                testId="stage-models"
                chrome="border"
                labelColor="var(--text-secondary)"
                fontWeight={400}
                onClick={toggle}
                expanded={open}
                title={`${modelChips.length} model choice${modelChips.length === 1 ? '' : 's'} this step's agents were pinned to when this flight started — click for which agent runs on what`}
                label={(
                  <span className="inline-flex items-baseline gap-1.5">
                    <span className="cl-rubric">models</span>
                    <span className="font-mono">{modelChips.length}</span>
                    <span aria-hidden="true" className="text-[9px] text-muted">▾</span>
                  </span>
                )}
              />
            )}
          </ModelPlanPopover>
        )}
        <StageStatusChip status={row.status} />
        {/* Advanced setup appears once the config EXISTS on disk — approved
            (done) or pre-existing (skipped, the scaffold had nothing to do).
            Not while generating, and not at the approval checkpoint: there the
            in-place editor (per-service ✎) is the one editing surface, so the
            fork stays a two-button decision. */}
        {stage.key === 'scaffold' && (stage.status === 'done' || stage.status === 'skipped') && onOpenConfig && (
          <DisabledControlTooltip>
            <button
              type="button"
              data-testid="feature-setup-advanced"
              /* Locked while the flight is running (the run/authoring stages own
                 the config) — matches the inline FeatureSetupPanel's `editable`
                 gate below; only editable once the flight is idle. */
              disabled={flight.status === 'running' || externalMutationOwner != null}
              onClick={() => onOpenConfig(flight.feature)}
              className="cl-button min-h-6 shrink-0 px-2 py-0.5 text-[11px]"
              title={externalMutationOwner
                ? externalMutationTooltip(externalMutationOwner, 'change advanced setup')
                : flight.status === 'running'
                ? 'Advanced setup is locked while the flight is running'
                : undefined}
            >
              ⚙ Advanced setup
            </button>
          </DisabledControlTooltip>
        )}
        {drillThrough && (
          <button
            type="button"
            data-testid={`stage-drill-${stage.key}`}
            onClick={drillThrough.onClick}
            className="cl-button min-h-6 shrink-0 px-2 py-0.5 text-[11px] text-accent"
          >
            {drillThrough.label}
          </button>
        )}
      </div>

      {/* The stage's own content column — every card on STAGE_COLUMN, stacked on
          the same gap the pane used to carry. */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">

      {/* Where are we — one plain sentence, always computed. R84: no longer
          painted in the panel (the left rail already carries this stage's
          name and status dot); it now surfaces as the rail row's hover
          tooltip (see FlightDetail's railRows). Stays sr-only rather than
          gone so a screen-reader user gets it without a mouse. */}
      <div data-testid="stage-state-line" className="sr-only">
        {stageStateLine(stage, flight, companion ?? undefined)}
      </div>

      {/* No download on the kicker line any more: the deliverable card below
          offers it beside the filename it fetches, and every archive has its own
          row in the reports list — a third button for the same file, a hand's
          width above both, is the duplication R82 removed for Restart. */}
      {/* R83: the band renders in EVERY state — measured tiles where the stage
          has evidence, placeholders where it doesn't yet, sweeping while it
          works. A stage pane no longer collapses to a bare sentence, and a value
          lands in the slot its placeholder held. */}
      <FactsGrid facts={facts} awaiting={awaitingData} />

      {/* The recovery card always follows At a glance. Test Run owns a separate
          facts band inside TestRunPanel, so that panel receives the same card in
          the same slot instead of rendering it above the band. */}
      {!runMerged && pausedNotice}

      {/* Repo scan (R72c): one intent card, then one repo card per inspected
          repo carrying its own location + env files. */}
      {stage.key === 'scout' && (
        <RepoScanPanel
          flight={flight}
          status={stage.status}
          envFiles={(() => {
            const ev = (stage.evidence ?? {}) as Record<string, unknown>
            return Array.isArray(ev.envFiles) ? (ev.envFiles as unknown[]).filter((f): f is string => typeof f === 'string') : []
          })()}
          onChangeInputs={onStartFlight ? () => onStartFlight(flight.feature, 'fresh') : undefined}
          mutationLockedReason={externalMutationOwner
            ? externalMutationTooltip(externalMutationOwner, 'change the flight inputs')
            : undefined}
        />
      )}

      {/* Suite setup: the boot proof sits directly under the band, ABOVE the
          config cards. The band's "Services booted 2/2" and "Boot time" are
          summaries of exactly these rows, so they read as one block; the config
          digest below is editable INPUT, a different kind of thing. Putting the
          config first separated a number from the evidence behind it by a
          screenful of start commands. */}
      {(stage.key === 'scaffold' || stage.key === 'env-capture') && (
        <BootCheckPanel
          awaiting={awaitingData}
          boot={band.boot ?? null}
          recorded={(() => {
            const ev = ((companion ?? stage).evidence ?? {}) as Record<string, unknown>
            const boot = ev.boot as { services?: Array<{ name?: string; status?: string }> } | undefined
            return boot?.services ?? []
          })()}
        />
      )}

      {/* Suite setup (R43): the editable digest over the REAL on-disk config
          — same doc Advanced setup (FeatureConfigEditor) edits, live both
          ways. The Advanced setup button rides the stage header above. */}
      {stage.key === 'scaffold' && (
        <FeatureSetupPanel
          feature={flight.feature}
          awaiting={awaiting}
          editable={flight.status !== 'running' && externalMutationOwner == null}
          lockedTitle={externalMutationOwner
            ? externalMutationTooltip(externalMutationOwner, 'change suite setup')
            : flight.status === 'running'
              ? 'Suite setup is locked while the flight is running'
              : undefined}
          refreshKey={configRefreshKey}
        />
      )}

      {/* Requirements (R74): while parked on prd-source the FORK owns the
          surface (manual drop zone vs the two agent hints); otherwise the
          read-only docs panel — locked once approved. The folded
          prd-summary's status chips the panel header (R59). The fork is
          gated on the FLIGHT being parked too: a stale checkpoint on a
          paused/aborted record must never render an answerable ask that can
          only 409 (respond requires waiting-for-approval). */}
      {stage.key === 'docs' && (
        flight.status === 'waiting-for-approval' && checkpointStage?.checkpoint?.kind === 'prd-source' ? (
          <RequirementsFork
            flightId={flightId}
            flight={flight}
            refreshKey={docsRefreshKey}
            onResponded={onResponded}
            listing={band.docsListing}
          />
        ) : (
          <FlightDocsPanel
            feature={flight.feature}
            awaiting={awaiting}
            approved={stage.status === 'done'}
            refreshKey={docsRefreshKey}
            listing={band.docsListing}
            summaryStatus={companion ? presentedStageStatus(companion) : undefined}
            summaryStage={companion ?? undefined}
            requirementCount={
              typeof (companion?.evidence as Record<string, unknown> | undefined)?.requirementCount === 'number'
                ? ((companion!.evidence as Record<string, unknown>).requirementCount as number)
                : undefined
            }
          />
        )
      )}

      {/* Test Run (R80): the run rendered ONCE as the Latest-run hero —
          identity, metric tiles, failing tests, live controls, and the previous
          runs. Owns its own run-detail/runs poll; the run detail page holds the
          failure evidence and the full agent transcript.

          R82 — mounted whenever the stage HAS a run, not only while the row is
          non-pending. A flight pause flips the open row back to `pending` (it
          keeps its startedAt), and the old gate unmounted the whole hero with
          it: the pane went blank and read as "I lost my progress". Nothing was
          lost — pause deliberately does NOT abort the run (see the run stage
          adapter's `interrupt`), so the run is often still going. Keeping it
          mounted keeps its verdict, its score and its failing tests on screen,
          and the poll alive, while the flight waits for Continue. */}
      {runMerged && (
        <TestRunPanel
          feature={flight.feature}
          runId={runId}
          awaiting={awaiting}
          live={Boolean(runLive) || live}
          evidence={runEvidence}
          onOpenRun={drill.onOpenRun}
          onError={onActionError}
          pausedNotice={pausedNotice}
          mutationLockedReason={externalMutationOwner
            ? externalMutationTooltip(externalMutationOwner, 'stop or change this run')
            : undefined}
        />
      )}

      {/* Test authoring & coverage: the two distributions behind the band's
          counts — spec depth and requirement gap kinds. Above the pass timeline
          because it describes the RESULT; the timeline is how it got there. */}
      {stage.key === 'specs-coverage' && <CoverageCompositionPanel ledger={band.ledger ?? null} awaiting={awaitingData} />}

      {/* Test authoring & coverage (R27): the author↔map loop as a pass
          timeline — coverage % after each mapping feeds the next authoring. */}
      {loopProgress
        ? <SpecsPassTimeline progress={loopProgress} live={live} failed={stage.status === 'failed'} />
        : stage.key === 'specs-coverage' && awaiting
          ? (
            // The loop's own shape before it starts: the same card, kicker and
            // row list the timeline becomes, so the card doesn't appear from
            // nowhere on the first pass.
            <StageColumn>
              <SkeletonPanel kicker="Passes" awaiting={awaiting} testId="specs-pass-skeleton" variant="rows" rows={2} />
            </StageColumn>
          )
          : null}

      {/* Parallel readiness: the concurrent-boot evidence, then what was edited
          to get there. */}
      {stage.key === 'portify' && (
        <>
          <DoubleBootPanel portify={band.portify ?? null} awaiting={awaitingData} />
          <OverlayPanel portify={band.portify ?? null} awaiting={awaitingData} />
          {band.portify && standalonePortifyActionable && !flightOwnsPortify && (
            <StageColumn>
              <div className="cl-frame p-4">
                <PortifyWorkflowControls manifest={band.portify} onChanged={onResponded} />
              </div>
            </StageColumn>
          )}
        </>
      )}

      {/* Evaluation Report: this flight's deliverable, then every archive ever
          built for the suite — the stage is where reports are collected, not just
          where the newest one is announced. */}
      {stage.key === 'evaluation-export' && (() => {
        // A workspace-probed task id is the feature's NEWEST completed export,
        // whatever produced it (a manual export from the coverage page
        // included) — calling that "this flight's report" attributes another
        // surface's work to the flight. The recorded path (stage evidence
        // written at settle, or the flight's own links) keeps the claim.
        const probed = stage.evidenceSource === 'workspace' && !flight.links?.evaluationTaskId
        return (
          <>
            <EvaluationDeliverablePanel task={band.evalTask ?? null} awaiting={awaiting} probed={probed} />
            <AllReportsPanel feature={flight.feature} pinnedTaskId={deliverableEvalTaskId} awaiting={awaiting} probed={probed} />
          </>
        )
      })()}

      {(row.status === 'failed' && error) && (
        <StageErrorPanel flightId={flightId} stageLabel={row.label} detail={error} errorDetail={errorDetail} mutationLockedReason={externalMutationOwner
          ? externalMutationTooltip(externalMutationOwner, 'apply a repository remedy')
          : undefined} />
      )}

      {/* prd-source renders as the RequirementsFork above; EVERY other kind —
          run-failed included, as of R82 — keeps the generic card. The run-failed
          fork used to be a bespoke amber slab fused inside the Test Run hero
          (R80); it now sits here, in the one place a flight asks its questions,
          so a run's decision looks and lands like a config approval or a portify
          save. Gated on the flight being parked: responding to a paused/aborted
          record's stale checkpoint can only 409. */}
      {flight.status === 'waiting-for-approval' && checkpointStage?.checkpoint
        && checkpointStage.checkpoint.kind !== 'prd-source'
        && checkpointStage.checkpoint.kind !== 'external-work' && (
        <CheckpointControls flightId={flightId} flight={flight} checkpoint={checkpointStage.checkpoint} onResponded={onResponded} />
      )}

      </div>
      </div>
      </div>
      {/* R66: one activity rail per stage — the conductor's tagged system lines
          and the stage's agent timeline (if any) on a single block. The run
          stage is agentless at the flight level (its repair agent's timeline is
          on the run detail drill-through), so R80 cut its near-empty band; the
          hero carries a collapsed "Repairs" disclosure instead. */}
      {!runMerged && (
        <StageActivityRail
          stageKey={stage.key}
          evaluationTaskId={stage.key === 'evaluation-export' ? activityEvalTask?.taskId ?? null : undefined}
          source={activitySource}
          sessionSources={sessionSources}
          live={live || evaluationLive || externalSessions.some((session) => session.status === 'running')}
          settled={settled}
          log={combinedLog}
          externalSessions={externalSessions}
          open={activityOpen}
          onOpenChange={onActivityOpenChange}
          {...(stage.key === 'portify' ? { empty: PORTIFY_NO_TRANSCRIPT } : {})}
        />
      )}
    </div>
  )
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
