import type { FlightManifest, FlightStage, FlightStageKey } from '@/shared/api/client'
import { AgentSessionView, type AgentSessionSource } from '@/shared/ui/AgentSessionView'
import { TestRunPanel, type RunStageEvidence } from './TestRunPanel'
import { FeatureSetupPanel, FlightDocsPanel, RepoScanPanel, RequirementsFork } from './FlightStagePanels'
import type { FlightLauncherIntent } from '@/shared/state/nav-state'
import type { ConfigTab } from '@/shared/lib/workspace-view-state'
import { evaluationTaskId, FactsGrid, StageColumn, StageStatusChip, portifyWorkflowId, specsCoverageProgress, stageFacts, stageStateLine, type StageRailRow } from './stage-meta'
import { useEvaluationExports } from '@/features/evaluation'
import { CheckpointControls } from './CheckpointControls'
import { AGENT_STAGE_DIRS, stageDrillThrough } from './FlightDetail'
import type { FlightDrillThroughs } from './FlightPage'
import { StageErrorPanel, StagePausedPanel, pausedResumeKind } from './StageStatePanels'
import { SkeletonPanel, awaitingFor } from '@/shared/ui/Skeleton'
import { useStageBandData } from './use-stage-band-data'
import {
  AllReportsPanel,
  BootCheckPanel,
  CoverageCompositionPanel,
  DoubleBootPanel,
  EvaluationDeliverablePanel,
  OverlayPanel,
} from './StageEvidencePanels'
import { SpecsPassTimeline, StageActivity, truncate } from './StageActivity'

export { AgentBlock, SpecsPassTimeline, StageActivity, specsPhaseSub, truncate } from './StageActivity'

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
  title: 'No transcript on record',
  body: 'The port work is kept as evidence, not as a replay — the side-by-side boot and the port changes above are what it produced.',
}

export function StageDetail({
  flightId,
  flight,
  row,
  stage,
  companion,
  runLive,
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
  // R83: the pane keeps its SETTLED layout in every state — each card a finished
  // stage shows renders as its own skeleton until it has content. Undefined once
  // the stage settles, so a card with genuinely nothing to show still renders
  // nothing rather than promising more.
  const awaiting = awaitingFor(row.status, live)
  // The Evaluation Report's deliverable: one resolved export task feeds both the
  // facts (run · report mode · archive name) and the activity rail below, so the
  // card reads the same on a conducted flight and a derived one.
  const evalTaskId = evaluationTaskId(stage, flight)
  const { taskById } = useEvaluationExports()
  // Sources outside the flight record (ledger, boot run, portify workflow,
  // config, envsets, docs) — resolved for the VISIBLE stage only.
  const band = useStageBandData(
    flight,
    stage,
    companion,
    evalTaskId ? taskById(evalTaskId) : null,
  )
  // The same hold, for the cards the band's own sources feed. `live` is the
  // right fill and not a fourth state: the three states answer WHY the slot is
  // empty, and "a value is on its way" is what a fetch in flight means — `idle`
  // would tell the user to act and `failed` that nothing is coming. A stage that
  // is genuinely awaiting outranks it, so a running stage keeps its own reason.
  const awaitingData = awaiting ?? (band.pending ? 'live' : undefined)
  const facts = stageFacts(stage, flight, companion ?? undefined, band)
  const drillThrough = stageDrillThrough(stage, flight, drill, companion, onOpenConfig)
  const runId = runMerged
    ? (((stage.evidence as Record<string, unknown> | undefined)?.runId as string | undefined) ?? flight.links?.runId)
    : undefined
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

  // R66: every stage's activity is the same rail. Resolve its one agent source
  // (if any): agent stages tail their flight session; the Evaluation Report
  // tails its export task (kind:'evaluation' — a localized rewrite streams a
  // timeline, a raw export has none and shows only its system rows). Agentless
  // stages pass no source and render system rows alone.
  // Portify's agent lives under the WORKFLOW dir (logs/portify/<wf>), not a
  // flight sidecar — tail it through the portify source the wizard already
  // uses, keyed by the id the adapter pins as live progress. Without this the
  // stage's longest phase (the agent editing) shows an empty rail.
  const portifyId = portifyWorkflowId(stage)
  const activitySource: AgentSessionSource | undefined =
    evalTaskId ? { kind: 'evaluation', taskId: evalTaskId, live }
    : portifyId ? { kind: 'portify', workflowId: portifyId, live }
    : agentDir ? { kind: 'flight', flightId, stage: agentDir, live }
    : undefined
  const activityKey = evalTaskId ? `evaluation:${evalTaskId}` : portifyId ? `portify:${portifyId}` : (agentDir ?? 'system-only')

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
        <StageStatusChip status={row.status} />
        {/* Advanced setup appears once the config EXISTS on disk — approved
            (done) or pre-existing (skipped, the scaffold had nothing to do).
            Not while generating, and not at the approval checkpoint: there the
            in-place editor (per-service ✎) is the one editing surface, so the
            fork stays a two-button decision. */}
        {stage.key === 'scaffold' && (stage.status === 'done' || stage.status === 'skipped') && onOpenConfig && (
          <button
            type="button"
            data-testid="feature-setup-advanced"
            /* Locked while the flight is running (the run/authoring stages own
               the config) — matches the inline FeatureSetupPanel's `editable`
               gate below; only editable once the flight is idle. */
            disabled={flight.status === 'running'}
            onClick={() => onOpenConfig(flight.feature)}
            className="cl-button shrink-0 px-2 py-0.5 text-[11px]"
            title={flight.status === 'running'
              ? 'Advanced setup is locked while the flight is running'
              : undefined}
          >
            ⚙ Advanced setup
          </button>
        )}
        {drillThrough && (
          <button
            type="button"
            data-testid={`stage-drill-${stage.key}`}
            onClick={drillThrough.onClick}
            className="cl-button shrink-0 px-2 py-0.5 text-[11px] text-accent"
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

      {/* Paused with nothing else to act on (no checkpoint, no error): the
          "how to pick it back up" card fills the void the state sentence alone
          left, and points up to the header's one Continue. Only renders on the
          single stage Continue resumes (pausedResumeKind mirrors stageStateLine),
          and never alongside the checkpoint/error cards below (those states are
          not `paused` + `pending`). */}
      {(() => {
        const kind = pausedResumeKind(stage, flight)
        if (!kind) return null
        // R82: the run stage keeps its hero mounted through a pause, so the
        // resume note is a line above real evidence, not a card filling a void.
        return <StagePausedPanel kind={kind} compact={runMerged && Boolean(runId)} />
      })()}

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
          editable={flight.status !== 'running'}
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
          />
        ) : (
          <FlightDocsPanel
            feature={flight.feature}
            awaiting={awaiting}
            approved={stage.status === 'done'}
            refreshKey={docsRefreshKey}
            summaryStatus={companion?.status}
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
      {runMerged && (runId || awaiting) && (
        <TestRunPanel
          feature={flight.feature}
          runId={runId}
          awaiting={awaiting}
          live={Boolean(runLive) || live}
          evidence={runEvidence}
          onOpenRun={drill.onOpenRun}
          onError={onActionError}
        />
      )}

      {/* Test authoring & coverage: the two distributions behind the band's
          counts — spec depth and requirement gap kinds. Above the pass timeline
          because it describes the RESULT; the timeline is how it got there. */}
      {stage.key === 'specs-coverage' && <CoverageCompositionPanel ledger={band.ledger ?? null} awaiting={awaitingData} />}

      {/* Test authoring & coverage (R27): the author↔map loop as a pass
          timeline — coverage % after each mapping feeds the next authoring. */}
      {loopProgress
        ? <SpecsPassTimeline progress={loopProgress} live={live} />
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
        </>
      )}

      {/* Evaluation Report: this flight's deliverable, then every archive ever
          built for the suite — the stage is where reports are collected, not just
          where the newest one is announced. */}
      {stage.key === 'evaluation-export' && (
        <>
          <EvaluationDeliverablePanel task={band.evalTask ?? null} awaiting={awaiting} />
          <AllReportsPanel feature={flight.feature} pinnedTaskId={evalTaskId} awaiting={awaiting} />
        </>
      )}

      {(row.status === 'failed' && error) && (
        <StageErrorPanel flightId={flightId} stageLabel={row.label} detail={error} errorDetail={errorDetail} />
      )}

      {/* prd-source renders as the RequirementsFork above; EVERY other kind —
          run-failed included, as of R82 — keeps the generic card. The run-failed
          fork used to be a bespoke amber slab fused inside the Test Run hero
          (R80); it now sits here, in the one place a flight asks its questions,
          so a run's decision looks and lands like a config approval or a portify
          save. Gated on the flight being parked: responding to a paused/aborted
          record's stale checkpoint can only 409. */}
      {flight.status === 'waiting-for-approval' && checkpointStage?.checkpoint
        && checkpointStage.checkpoint.kind !== 'prd-source' && (
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
        <StageActivity
          source={activitySource}
          sourceKey={activityKey}
          live={live}
          settled={settled}
          log={combinedLog}
          {...(stage.key === 'portify' ? { empty: PORTIFY_NO_TRANSCRIPT } : {})}
        />
      )}
    </div>
  )
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
