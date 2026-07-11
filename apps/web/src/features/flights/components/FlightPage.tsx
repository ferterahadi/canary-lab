import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as api from '../../../shared/api/client'
import type {
  FlightCheckpoint,
  FlightIndexEntry,
  FlightManifest,
  FlightStage,
  FlightStageKey,
  SpecsCoverageProgress as SpecsCoverageProgressT,
} from '../../../shared/api/client'
import type { JournalEntry, RunDetail, RunIndexEntry } from '../../../shared/api/types'
import { AgentSessionView, type AgentSessionSource } from '../../agent-sessions/components/AgentSessionView'
import { StatusDot } from '../../config/components/atoms'
import { useEvaluationExports } from '../../evaluation/state/EvaluationExportContext'
import { RunRow } from '../../runs/components/RunRow'
import { ActivityOnlyRow, FLIGHT_STATUS_TONE, FlightStatusChip, NotFlownRow, StageMiniRail, featureActivityRows, flightStatusLabel } from './FlightsPill'
import { FeatureSetupPanel, FlightDocsPanel, RepoScanPanel } from './FlightStagePanels'
import type { FeatureActivity } from '../state/feature-activity'
import {
  FactsGrid,
  STAGE_COMPANION,
  STAGE_ICON,
  StageStatusChip,
  formatDuration,
  specsCoverageProgress,
  stageFacts,
  stageRailRows,
  stageStateLine,
  stageStatusTone,
  type StageFact,
  type StageRailRow,
} from './stage-meta'

// Flight detail — the routed full-screen view (?view=flights&flight=<id>)
// that owns a flight's lifecycle: a stage rail on the left (harness-computed
// verdict per stage), the selected stage's "trailer" on the right (R16): one
// state line, the agent's identity + live output where an agent acts, and a
// view-details affordance — the raw evidence/log stay behind the disclosure,
// the real surfaces behind the drill-through. Without a flight id it renders
// the landing list. Live via `flights-changed` events (refreshKey) + a gentle
// poll while the flight is active.

/** Stage key → the sidecar dir its adapter pins an agent-session ref into.
 *  Stages without an agent (similarity, scaffold, run…) have no entry. */
const AGENT_STAGE_DIRS: Partial<Record<FlightStageKey, string>> = {
  'scout': 'scout',
  'prd-summary': 'prd-summary',
  'specs-coverage': 'specs-coverage',
}

/** Drill-through targets: each stage view is a LENS onto the real underlying
 *  surface — the actual run detail, coverage ledger, portify workflow — never
 *  a re-implementation of them (R6). */
export interface FlightDrillThroughs {
  onOpenRun?: (feature: string, runId: string) => void
  onOpenCoverage?: (feature: string) => void
  onOpenPortify?: (workflowId: string) => void
}

export function FlightPage({
  flightId,
  refreshKey,
  onSelectFlight,
  onClose,
  activity,
  features,
  onOpenActivity,
  onStartFlight,
  onOpenConfig,
  configRefreshKey,
  docsRefreshKey,
  onOpenRun,
  onOpenCoverage,
  onOpenPortify,
}: {
  flightId: string | null
  refreshKey: number
  onSelectFlight: (flightId: string | null) => void
  onClose: () => void
  /** Per-feature live activity (runs / portify / authoring) — App owns it. */
  activity?: Map<string, FeatureActivity>
  /** Every workspace feature name — the landing lists them 1:1 (R49). */
  features?: string[]
  /** Open the real surface behind an activity-only landing row. */
  onOpenActivity?: (feature: string, activity: FeatureActivity) => void
  /** Opens the stage-entry launcher for the flight's feature (R25 re-fly). */
  onStartFlight?: (feature: string) => void
  /** Opens FeatureConfigEditor — the Feature Setup panel's Advanced setup. */
  onOpenConfig?: (feature: string) => void
  /** Bumped on features-changed → the setup digest refetches (two-way sync). */
  configRefreshKey?: number
  /** Bumped on coverage-changed → the Requirements docs list refetches. */
  docsRefreshKey?: number
} & FlightDrillThroughs) {
  return (
    <div className="flex h-full w-full flex-col" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      {flightId
        ? <FlightDetail flightId={flightId} refreshKey={refreshKey} onClose={onClose} onBackToList={() => onSelectFlight(null)} onStartFlight={onStartFlight} onOpenConfig={onOpenConfig} configRefreshKey={configRefreshKey} docsRefreshKey={docsRefreshKey} activity={activity} drill={{ onOpenRun, onOpenCoverage, onOpenPortify }} />
        : <FlightsLanding refreshKey={refreshKey} activity={activity} features={features} onSelectFlight={onSelectFlight} onOpenActivity={onOpenActivity} onStartFlight={onStartFlight} onClose={onClose} />}
    </div>
  )
}

function FlightsLanding({
  refreshKey,
  activity = new Map(),
  features = [],
  onSelectFlight,
  onOpenActivity,
  onStartFlight,
  onClose,
}: {
  refreshKey: number
  activity?: Map<string, FeatureActivity>
  features?: string[]
  onSelectFlight: (flightId: string) => void
  onOpenActivity?: (feature: string, activity: FeatureActivity) => void
  onStartFlight?: (feature: string) => void
  onClose: () => void
}) {
  const [flights, setFlights] = useState<FlightIndexEntry[]>([])
  useEffect(() => {
    let alive = true
    api.listFlights().then((f) => { if (alive) setFlights(f) }).catch(() => {})
    return () => { alive = false }
  }, [refreshKey])

  return (
    <>
      <header className="flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--border-default)' }}>
        <h1 className="text-sm font-semibold">🕊️ Flights</h1>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          npx canary-lab flight &lt;repo&gt; "what to test"
        </span>
        <div className="flex-1" />
        <button type="button" onClick={onClose} className="cl-button px-2.5 py-1 text-xs">Close</button>
      </header>
      {flights.length === 0 && activity.size === 0 && features.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
          No flights yet — start one from a terminal and it appears here live.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5 overflow-auto p-3 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
          {featureActivityRows(flights, activity, features).map((row) => (
            <li key={row.flight?.flightId ?? `activity-${row.feature}`}>
              {row.flight ? (
                <button
                  type="button"
                  data-testid={`flight-row-${row.flight.flightId}`}
                  onClick={() => onSelectFlight(row.flight!.flightId)}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
                  style={{ border: '1px solid var(--border-default)' }}
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{row.feature}</span>
                  <span className="truncate text-[11px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {(row.flight.repoPaths ?? []).join(', ')}
                  </span>
                  <StageMiniRail stages={row.flight.stages ?? []} />
                  <FlightStatusChip flight={row.flight} activity={row.activity} />
                </button>
              ) : row.activity ? (
                <ActivityOnlyRow feature={row.feature} activity={row.activity} onOpen={(f, a) => onOpenActivity?.(f, a)} />
              ) : (
                <NotFlownRow feature={row.feature} onStart={(f) => onStartFlight?.(f)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function FlightDetail({
  flightId,
  refreshKey,
  onBackToList,
  onClose,
  onStartFlight,
  onOpenConfig,
  configRefreshKey,
  docsRefreshKey,
  activity,
  drill,
}: {
  flightId: string
  refreshKey: number
  onBackToList: () => void
  onClose: () => void
  onStartFlight?: (feature: string) => void
  onOpenConfig?: (feature: string) => void
  configRefreshKey?: number
  docsRefreshKey?: number
  /** Per-feature live activity — drives the run row's live icon (R64). */
  activity?: Map<string, FeatureActivity>
  drill: FlightDrillThroughs
}) {
  const [flight, setFlight] = useState<FlightManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedStage, setSelectedStage] = useState<FlightStageKey | null>(null)

  const refetch = useCallback((): void => {
    api.getFlight(flightId)
      .then((m) => { setFlight(m); setError(null) })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [flightId])

  // WS `flights-changed` bumps refreshKey; the poll is the reconnect-safe
  // backstop while the flight is active (the bus has no replay).
  useEffect(() => { refetch() }, [refetch, refreshKey])
  const active = flight?.status === 'running' || flight?.status === 'waiting-for-approval'
  useEffect(() => {
    if (!active) return
    const id = setInterval(refetch, 2000)
    return () => clearInterval(id)
  }, [active, refetch])

  // The rail hides conductor plumbing (R21) and merges run+heal into one user
  // step (R22) — selection and auto-pick both work on these visible rows.
  // While a run for this feature is live, the run row reads `running` (blue +
  // pulse) instead of its settled verdict — the icon must never show a green
  // tick over a run that is still working (R64).
  const runLive = flight ? activity?.get(flight.feature)?.kind === 'running' : false
  const railRows = useMemo(() => {
    const rows = flight ? stageRailRows(flight.stages) : []
    return runLive ? rows.map((r) => (r.key === 'run' && r.status !== 'running' ? { ...r, status: 'running' as const } : r)) : rows
  }, [flight, runLive])

  // Default the selected stage to the one that needs eyes: waiting → running →
  // first failed → last done. The user's explicit pick wins.
  const autoStage = useMemo((): FlightStageKey | null => {
    const pick =
      railRows.find((s) => s.status === 'waiting-for-approval')
      ?? railRows.find((s) => s.status === 'running')
      ?? railRows.find((s) => s.status === 'failed')
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

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        <div>Flight {flightId} could not be loaded: {error}</div>
        <button type="button" onClick={onBackToList} className="cl-button px-2.5 py-1 text-xs">All flights</button>
      </div>
    )
  }
  if (!flight) {
    return <div className="flex flex-1 items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>Loading flight…</div>
  }

  const tone = FLIGHT_STATUS_TONE[flight.status]
  return (
    <>
      <header className="flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--border-default)' }}>
        {/* R17: the title answers "what is this?" alone on its own line; the
            status chip gets its own slot on the line below so "is it done?"
            never competes with the name. */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">🕊️ {flight.feature}</h1>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <span
              data-testid="flight-status"
              title={flight.status === 'paused'
                ? (flight.pauseReason === 'user' ? 'Paused by you — Continue resumes it'
                  : flight.pauseReason === 'restart' ? 'Interrupted by a server restart — Continue resumes it'
                  : 'A stage failed — Continue retries it')
                : undefined}
              className="inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
              style={{ color: tone, border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)` }}
            >
              {flight.status === 'running' && <StatusDot state="running" className="shrink-0" />}
              {flightStatusLabel(flight.status)}
            </span>
            <span className="truncate text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {flight.repoPaths.join(', ')} · "{flight.description}"
            </span>
          </div>
        </div>
        {/* R48: the control cluster is always present — Pause+Stop while the
            flight works, Continue+Start over when paused, Start over+Repeat a
            step when settled. Never hunt for the button. */}
        {!active && onStartFlight && (
          <button
            type="button"
            data-testid="flight-refly"
            onClick={() => onStartFlight(flight.feature)}
            className="cl-button px-2.5 py-1 text-xs"
          >
            Repeat a step…
          </button>
        )}
        {flight.status === 'paused' && (
          <button
            type="button"
            data-testid="flight-resume"
            onClick={() => { api.resumeFlight(flightId).then(refetch).catch(() => {}) }}
            className="cl-button px-2.5 py-1 text-xs"
            style={{ color: 'rgb(56, 189, 248)' }}
          >
            Continue
          </button>
        )}
        {!active && <StartOverButton flightId={flightId} onDone={refetch} />}
        {!active && <DeleteFlightButton flightId={flightId} onDeleted={onBackToList} />}
        {active && (
          <button
            type="button"
            data-testid="flight-pause"
            onClick={() => { api.pauseFlight(flightId).then(refetch).catch(() => {}) }}
            className="cl-button px-2.5 py-1 text-xs"
            title="Pause the flight — in-flight stage work stops safely; Continue resumes it"
          >
            ⏸ Pause
          </button>
        )}
        {active && (
          <button
            type="button"
            data-testid="flight-abort"
            onClick={() => { api.abortFlight(flightId).then(refetch).catch(() => {}) }}
            className="cl-button px-2.5 py-1 text-xs"
            style={{ color: 'var(--danger)' }}
          >
            ⏹ Stop
          </button>
        )}
        <button type="button" onClick={onClose} className="cl-button px-2.5 py-1 text-xs">Close</button>
      </header>

      <FlightSummaryStrip flight={flight} />

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Flight stages"
          className="flex w-[240px] shrink-0 flex-col gap-0.5 overflow-auto border-r p-2 scrollbar-thin"
          style={{ borderColor: 'var(--border-default)', scrollbarGutter: 'stable' }}
        >
          {railRows.map((s) => {
            const selected = s.key === stageKey
            const t = stageStatusTone(s.status)
            // A merged row's wall-clock spans its primary + folded companion
            // (run→heal, scaffold→env-capture, docs→prd-summary) — R61.
            const primary = flight.stages.find((st) => st.key === s.key)
            const folded = flight.stages.find((st) => st.key === STAGE_COMPANION[s.key])
            const duration = formatDuration(primary?.startedAt, folded?.endedAt ?? primary?.endedAt)
            return (
              <button
                key={s.key}
                type="button"
                data-testid={`stage-rail-${s.key}`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => setSelectedStage(s.key)}
                title={s.key}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-white/[0.04]"
                style={{ background: selected ? 'var(--bg-selected)' : undefined }}
              >
                <span className="w-3 shrink-0 text-center font-semibold" style={{ color: t }} aria-hidden="true">
                  {STAGE_ICON[s.status]}
                </span>
                <span className="min-w-0 flex-1 truncate" style={{ color: s.status === 'pending' ? 'var(--text-muted)' : undefined }}>
                  {s.label}
                </span>
                {duration && s.status !== 'running' && (
                  <span className="shrink-0 text-[10px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
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
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Pick a stage.</div>
          ) : (
            <StageDetail key={stage.key} flightId={flightId} flight={flight} row={row} stage={stage} companion={companionStage} runLive={runLive} onResponded={refetch} onOpenConfig={onOpenConfig} configRefreshKey={configRefreshKey} docsRefreshKey={docsRefreshKey} drill={drill} />
          )}
        </main>
      </div>
    </>
  )
}

/** The stage's drill-through: a lens button into the real underlying surface. */
function stageDrillThrough(
  stage: FlightStage,
  flight: FlightManifest,
  drill: FlightDrillThroughs,
): { label: string; onClick: () => void } | null {
  const ev = (stage.evidence ?? {}) as Record<string, unknown>
  if (stage.key === 'run' || stage.key === 'heal') {
    const runId = typeof ev.runId === 'string' ? ev.runId : flight.links?.runId
    if (runId && drill.onOpenRun) {
      const open = drill.onOpenRun
      return { label: 'Open run detail →', onClick: () => open(flight.feature, runId) }
    }
  }
  if (stage.key === 'specs-coverage' && drill.onOpenCoverage && stage.status !== 'pending') {
    const open = drill.onOpenCoverage
    return { label: 'Open coverage ledger →', onClick: () => open(flight.feature) }
  }
  if (stage.key === 'portify' && drill.onOpenPortify && typeof ev.workflowId === 'string') {
    const open = drill.onOpenPortify
    const workflowId = ev.workflowId
    return { label: 'Open portify workflow →', onClick: () => open(workflowId) }
  }
  return null
}

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
function StageDetail({
  flightId,
  flight,
  row,
  stage,
  companion,
  runLive,
  onResponded,
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
  onOpenConfig?: (feature: string) => void
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
      : AGENT_STAGE_DIRS[stage.key] ?? (companion ? AGENT_STAGE_DIRS[companion.key] : undefined)
  const runMerged = stage.key === 'run'
  const live = row.status === 'running'
  const settled = row.status === 'done' || row.status === 'failed'
  const facts = stageFacts(stage, flight, companion ?? undefined)
  const drillThrough = stageDrillThrough(stage, flight, drill)
  const runId = runMerged
    ? (((stage.evidence as Record<string, unknown> | undefined)?.runId as string | undefined) ?? flight.links?.runId)
    : undefined
  // A pair row surfaces whichever half is parked on a checkpoint (the
  // missing-env checkpoint lives on the folded env-capture, run-failed on run).
  const checkpointStage =
    stage.status === 'waiting-for-approval' ? stage
    : companion?.status === 'waiting-for-approval' ? companion
    : null
  const error = stage.error ?? companion?.error
  const combinedLog = [stage.log, companion?.log].filter(Boolean).join('')

  // R66: every stage's activity is the same rail. Resolve its one agent source
  // (if any): agent stages tail their flight session; the Evaluation Report
  // tails its export task (kind:'evaluation' — a localized rewrite streams a
  // timeline, a raw export has none and shows only its system rows). Agentless
  // stages pass no source and render system rows alone.
  const evalTaskId = stage.key === 'evaluation-export'
    ? (((stage.evidence as Record<string, unknown> | undefined)?.taskId as string | undefined) ?? flight.links?.evaluationTaskId)
    : undefined
  const activitySource: AgentSessionSource | undefined =
    evalTaskId ? { kind: 'evaluation', taskId: evalTaskId, live }
    : agentDir ? { kind: 'flight', flightId, stage: agentDir, live }
    : undefined
  const activityKey = evalTaskId ? `evaluation:${evalTaskId}` : (agentDir ?? 'system-only')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* R66: header, facts and stage panels scroll here; the activity band
          below fills the rest of the pane so a long transcript scrolls in
          place instead of the whole stage view running off the bottom. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-semibold" title={stage.key}>{row.label}</h2>
        <StageStatusChip status={row.status} />
        <div className="flex-1" />
        {stage.key === 'evaluation-export' && <DownloadEvaluationAction flight={flight} stage={stage} />}
        {drillThrough && (
          <button
            type="button"
            data-testid={`stage-drill-${stage.key}`}
            onClick={drillThrough.onClick}
            className="cl-button shrink-0 px-2 py-0.5 text-[11px]"
            style={{ color: 'rgb(56, 189, 248)' }}
          >
            {drillThrough.label}
          </button>
        )}
      </div>

      {/* Where are we — one plain sentence, always present. */}
      <div data-testid="stage-state-line" className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {stageStateLine(stage, flight, companion ?? undefined)}
      </div>

      <FactsGrid facts={facts} />

      {/* Repo Scan (R57): repos + intent presented read-only — they freeze the
          moment the flight first starts; deleting the flight is the escape
          hatch (the panel says so). */}
      {stage.key === 'scout' && <RepoScanPanel flight={flight} />}

      {/* Feature setup (R43): the editable digest over the REAL on-disk config
          — same doc Advanced setup (FeatureConfigEditor) edits, live both ways. */}
      {stage.key === 'scaffold' && stage.status !== 'pending' && (
        <FeatureSetupPanel
          feature={flight.feature}
          editable={flight.status !== 'running'}
          refreshKey={configRefreshKey}
          onOpenConfig={onOpenConfig}
        />
      )}

      {/* Requirements (R44/R59): the docs manager lives where the flight pauses
          for docs — add files, link local paths, remove; linked docs marked ↗.
          The folded prd-summary's status chips the header (R59). */}
      {stage.key === 'docs' && stage.status !== 'pending' && (
        <FlightDocsPanel
          feature={flight.feature}
          locked={row.status === 'running'}
          refreshKey={docsRefreshKey}
          summaryStatus={companion?.status}
          onChanged={onResponded}
        />
      )}

      {/* Test Run (R22): what's running now, what each repair cycle fixed —
          no agent output, the run detail page holds the rest. */}
      {runMerged && runId && <RunRepairSummary runId={runId} active={live} />}

      {/* Test Run (R64): every run this feature has had, as the same cards the
          runs list renders — click drills into the real run detail. */}
      {runMerged && row.status !== 'pending' && (
        <FeatureRunsPanel feature={flight.feature} live={Boolean(runLive) || live} onOpenRun={drill.onOpenRun} />
      )}

      {/* Test authoring & coverage (R27): the author↔map loop as a pass
          timeline — coverage % after each mapping feeds the next authoring. */}
      {loopProgress && <SpecsPassTimeline progress={loopProgress} live={live} />}

      {(row.status === 'failed' && error) && (
        <div className="rounded border px-2.5 py-2 text-[11.5px]" style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border-default))', color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      {checkpointStage?.checkpoint && (
        <CheckpointControls flightId={flightId} flight={flight} checkpoint={checkpointStage.checkpoint} onResponded={onResponded} />
      )}

      </div>
      {/* R66: one activity rail per stage — the conductor's tagged system lines
          and the stage's agent timeline (if any) on a single block. */}
      <StageActivity
        source={activitySource}
        sourceKey={activityKey}
        live={live}
        settled={settled}
        log={combinedLog}
      />
    </div>
  )
}

/** The stage's activity band (R66): ONE consolidated block, identical for every
 *  stage. The conductor's `[tagged]` system lines and the stage's own agent
 *  timeline ride one `AgentSessionView` rail (system lines passed as
 *  `systemRows`, styled apart from the agent's rows). Agent stages tail their
 *  flight session; the Evaluation Report tails its export task; an agentless
 *  stage passes no `source` and shows system rows alone.
 *  `stage.log` has no timestamps, so the split is positional: agent chunks are
 *  mirrored into the log untagged, so the first/last untagged line brackets the
 *  agent's slot (→ `pre` before it, `post` after); a settled log with no
 *  untagged lines splits after the last spawn announcement (a tagged line
 *  ending in `…`). Untagged middles never render as system rows — the timeline
 *  shows them richer. Expanded fills ~half the pane; one "▸ View activity"
 *  disclosure once settled. */
function StageActivity({
  source,
  sourceKey,
  live,
  settled,
  log,
}: {
  /** The stage's one agent session, if it spawned one (flight agent, or the
   *  Evaluation Report's export task). Omitted for agentless stages — the rail
   *  then shows system rows alone. */
  source?: AgentSessionSource
  /** Remount key — swaps the timeline when the specs loop flips authoring→map,
   *  or between export tasks. */
  sourceKey: string
  live: boolean
  settled: boolean
  log: string
}) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const lines = log.split('\n').filter((l) => l.trim() !== '')
  const hasSource = source !== undefined
  if (lines.length === 0 && !hasSource) return null
  const open = userToggled ?? !settled

  const isTagged = (l: string): boolean => /^\[[\w-]+\]/.test(l)
  let pre = lines
  let post: string[] = []
  if (hasSource) {
    const firstUntagged = lines.findIndex((l) => !isTagged(l))
    if (firstUntagged >= 0) {
      let lastUntagged = firstUntagged
      for (let i = lines.length - 1; i >= firstUntagged; i--) {
        if (!isTagged(lines[i])) { lastUntagged = i; break }
      }
      pre = lines.slice(0, firstUntagged)
      post = lines.slice(lastUntagged + 1)
    } else if (!live) {
      // No agent chunks were mirrored — split after the adapters' spawn
      // announcement so the timeline still sits where the agent ran.
      let splitAt = lines.length
      for (let i = lines.length - 1; i >= 0; i--) {
        if (isTagged(lines[i]) && lines[i].trimEnd().endsWith('…')) { splitAt = i + 1; break }
      }
      pre = lines.slice(0, splitAt)
      post = lines.slice(splitAt)
    }
  }

  return (
    <section
      data-testid="stage-activity"
      className={`flex flex-col border-t ${open ? 'min-h-0 flex-1' : 'shrink-0'}`}
      style={{ borderColor: 'var(--border-default)', background: 'color-mix(in srgb, var(--bg-elevated) 22%, transparent)' }}
    >
      {/* R66: the boundary between the stage's detail (above) and its activity.
          One labelled bar for every stage; the toggle rides it once settled. */}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.11em]" style={{ color: 'var(--text-muted)' }}>
          Activity
        </span>
        <span className="h-px flex-1" style={{ borderTop: '1px dashed var(--border-default)' }} />
        {settled && (
          <button
            type="button"
            data-testid="stage-details-toggle"
            aria-expanded={open}
            onClick={() => setUserToggled(!open)}
            className="cl-button px-2 py-0.5 text-[11px]"
          >
            {open ? '▾ Hide' : '▸ Show'}
          </button>
        )}
      </div>
      {open && (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          {/* ONE rail for EVERY stage. The conductor's system lines and the
              stage's agent timeline (flight agent, or the export task) share it;
              an agentless stage (no `source`) renders system rows alone. */}
          <AgentBlock>
            <AgentSessionView key={sourceKey} source={source} systemRows={{ pre, post }} />
          </AgentBlock>
        </div>
      )}
    </section>
  )
}

/** "Start over" (R48): redo this record from stage 1 — destructive to the
 *  flight's stage evidence, so the button asks once inline before firing. */
function StartOverButton({ flightId, onDone }: { flightId: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!confirming) {
    return (
      <button
        type="button"
        data-testid="flight-start-over"
        onClick={() => setConfirming(true)}
        className="cl-button px-2.5 py-1 text-xs"
        title="Restart this flight from the beginning — its stage records are reset (artifacts on disk are kept and reused)"
      >
        ↺ Start over
      </button>
    )
  }
  return (
    <button
      type="button"
      data-testid="flight-start-over-confirm"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        api.redoFlight(flightId)
          .then(onDone)
          .catch(() => {})
          .finally(() => { setBusy(false); setConfirming(false) })
      }}
      className="cl-button px-2.5 py-1 text-xs"
      style={{ color: 'rgb(251, 191, 36)' }}
    >
      {busy ? 'Restarting…' : 'Really start over?'}
    </button>
  )
}

/** Delete a settled flight record (R57): the frozen repos/intent escape hatch.
 *  Two-click like Start over; the feature stays and returns to "not flown". */
function DeleteFlightButton({ flightId, onDeleted }: { flightId: string; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!confirming) {
    return (
      <button
        type="button"
        data-testid="flight-delete"
        onClick={() => setConfirming(true)}
        className="cl-button px-2.5 py-1 text-xs"
        title="Delete this flight record — the feature stays and reads as not flown. Repos and intent are frozen per flight; deleting is how you start fresh with different ones."
      >
        Delete flight
      </button>
    )
  }
  return (
    <button
      type="button"
      data-testid="flight-delete-confirm"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        api.deleteFlight(flightId)
          .then(onDeleted)
          .catch(() => {})
          .finally(() => { setBusy(false); setConfirming(false) })
      }}
      className="cl-button px-2.5 py-1 text-xs"
      style={{ color: 'var(--danger)' }}
    >
      {busy ? 'Deleting…' : 'Really delete?'}
    </button>
  )
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** The header's summary strip (R61): the flight's headline numbers — elapsed
 *  wall-clock, coverage %, run verdict, doc count, report readiness — derived
 *  entirely from the manifest; items that don't exist yet simply don't render. */
function FlightSummaryStrip({ flight }: { flight: FlightManifest }) {
  const items: Array<{ label: string; value: string; tone?: string }> = []

  const elapsed = formatDuration(flight.createdAt, flight.endedAt ?? flight.updatedAt)
  if (elapsed && (flight.endedAt || flight.status !== 'running')) {
    items.push({ label: flight.endedAt ? 'Elapsed' : 'Elapsed so far', value: elapsed })
  }

  const specs = flight.stages.find((s) => s.key === 'specs-coverage')
  const progress = specsCoverageProgress(specs)
  const lastMapped = progress?.passes.filter((p) => p.note == null).at(-1)
  if (lastMapped) {
    items.push({
      label: 'Coverage',
      value: `${lastMapped.coveragePct}%`,
      tone: lastMapped.gapsOpen === 0 ? 'rgb(52, 211, 153)' : 'rgb(251, 191, 36)',
    })
  }

  if (flight.runVerdict) {
    items.push({
      label: 'Run',
      value: flight.runVerdict,
      tone: flight.runVerdict === 'passed' ? 'rgb(52, 211, 153)' : flight.runVerdict === 'failed' ? 'var(--danger)' : 'var(--text-muted)',
    })
  }

  const docsEv = asRecord(flight.stages.find((s) => s.key === 'docs')?.evidence)
  const docs = Array.isArray(docsEv?.docs) ? docsEv.docs.length : 0
  if (docs > 0) items.push({ label: 'Docs', value: String(docs) })

  if (flight.links?.evaluationZip) items.push({ label: 'Report', value: 'ready', tone: 'rgb(52, 211, 153)' })

  if (items.length === 0) return null
  return (
    <div
      data-testid="flight-summary-strip"
      className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b px-4 py-1.5"
      style={{ borderColor: 'var(--border-default)' }}
    >
      {items.map((item) => (
        <span key={item.label} className="flex items-baseline gap-1.5 text-[11px]">
          <span className="text-[9.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            {item.label}
          </span>
          <span style={{ color: item.tone ?? 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{item.value}</span>
        </span>
      ))}
    </div>
  )
}

/** Distill the parsed feature.config + playwright.config into fact rows. Pure
 *  and defensive: config ASTs carry `$expr` stand-ins and hand-edited shapes —
 *  anything unreadable simply doesn't produce a row. */
export function configDigestFacts(config: unknown, playwright: unknown): StageFact[] {
  const facts: StageFact[] = []
  const repos = Array.isArray(asRecord(config)?.repos) ? (asRecord(config)!.repos as unknown[]) : []
  const repoNames: string[] = []
  const commands: Array<{ command: string; service: string; ports: string[] }> = []
  for (const r of repos) {
    const repo = asRecord(r)
    if (!repo) continue
    const name = typeof repo.name === 'string' ? repo.name : null
    const branch = typeof repo.branch === 'string' ? repo.branch : null
    if (name) repoNames.push(branch ? `${name} @ ${branch}` : name)
    const startCommands = Array.isArray(repo.startCommands) ? repo.startCommands : []
    for (const sc of startCommands) {
      const svc = asRecord(sc)
      if (!svc || typeof svc.command !== 'string') continue
      const ports = (Array.isArray(svc.ports) ? svc.ports : [])
        .map((p) => asRecord(p))
        .filter((p): p is Record<string, unknown> => p !== null)
        .map((p) => `${typeof p.name === 'string' ? p.name : '?'}${typeof p.env === 'string' ? ` (${p.env})` : ''}`)
      commands.push({ command: svc.command, service: typeof svc.name === 'string' ? svc.name : name ?? 'service', ports })
    }
  }
  if (repoNames.length > 0) facts.push({ label: 'Repos', value: repoNames.join(', '), mono: true })
  for (const c of commands) {
    facts.push({ label: commands.length === 1 ? 'Run command' : `Run · ${c.service}`, value: c.command, mono: true, title: c.service })
    if (c.ports.length > 0) facts.push({ label: 'Ports', value: c.ports.join(', '), mono: true })
  }
  const pw = asRecord(playwright)
  if (pw) {
    const use = asRecord(pw.use)
    const bits = [
      typeof pw.workers === 'number' ? `${pw.workers} worker${pw.workers === 1 ? '' : 's'}` : null,
      typeof pw.retries === 'number' ? `${pw.retries} retr${pw.retries === 1 ? 'y' : 'ies'}` : null,
      typeof use?.video === 'string' ? `video ${use.video}` : null,
      typeof use?.trace === 'string' ? `trace ${use.trace}` : null,
    ].filter(Boolean)
    if (bits.length > 0) facts.push({ label: 'Playwright', value: bits.join(' · ') })
  }
  return facts
}

/** Frame for a stage's consolidated activity (R66): the conductor's system
 *  rows and the agent's own timeline share one bordered, scrolling rail. Fills
 *  its half of the stage pane; the rail's own header names the agent. */
function AgentBlock({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border" style={{ borderColor: 'var(--border-default)' }}>
      {children}
    </div>
  )
}


function truncate(text: string, max: number): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The specs↔coverage loop as a pass timeline (R27): each settled pass shows
 *  what authoring bought (the ledger % after mapping — the number that feeds
 *  the NEXT pass's prompt); the live pass shows which half of author↔map is
 *  working now. Data is the adapter's structured progress, not parsed log. */
function SpecsPassTimeline({ progress, live }: { progress: SpecsCoverageProgressT; live: boolean }) {
  const phaseLabel =
    progress.phase === 'authoring' ? 'authoring tests' : progress.phase === 'validating' ? 'validating specs' : 'mapping coverage'
  if (!live && progress.passes.length === 0) return null
  return (
    <div data-testid="specs-pass-timeline">
      <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        Passes
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {progress.passes.map((p) => (
          <li key={p.pass} data-testid={`specs-pass-${p.pass}`} className="text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
            <span style={{ color: p.note ? 'rgb(251, 191, 36)' : 'rgb(52, 211, 153)' }}>Pass {p.pass}</span>
            {p.note
              ? ` — ${p.note}, retried with the errors in the next prompt`
              : ` — authored → mapped: ${p.coveragePct}% covered, ${p.gapsOpen} gap${p.gapsOpen === 1 ? '' : 's'} open`}
          </li>
        ))}
        {live && (
          <li data-testid="specs-pass-live" className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
            <StatusDot state="running" className="shrink-0" />
            <span>
              <span style={{ color: 'rgb(56, 189, 248)' }}>Pass {progress.pass}</span>
              {` — ${phaseLabel}…`}
            </span>
          </li>
        )}
      </ul>
    </div>
  )
}

/** Every test run this feature has had (R64), as the runs list's own cards —
 *  status chip (passed / healing / running / failed), pass counts from the run
 *  summary, click → the real run detail. Boot/benchmark/verify sessions are
 *  plumbing, not test runs — they don't render here. Polls gently while any
 *  run is live so a settling run flips its chip without a refresh. */
function FeatureRunsPanel({
  feature,
  live,
  onOpenRun,
}: {
  feature: string
  live: boolean
  onOpenRun?: (feature: string, runId: string) => void
}) {
  const [runs, setRuns] = useState<RunIndexEntry[]>([])
  const [details, setDetails] = useState<Map<string, RunDetail>>(new Map())
  useEffect(() => {
    let alive = true
    const load = (): void => {
      api.listRuns({ feature })
        .then(async (all) => {
          const shown = all
            .filter((r) => r.executionType !== 'boot' && r.executionType !== 'benchmark' && r.executionType !== 'verify')
            .slice(0, 6)
          if (!alive) return
          setRuns(shown)
          const pairs = await Promise.all(
            shown.map(async (r) => [r.runId, await api.getRunDetail(r.runId).catch(() => null)] as const),
          )
          if (alive) setDetails(new Map(pairs.filter((p): p is [string, RunDetail] => p[1] !== null)))
        })
        .catch(() => {})
    }
    load()
    if (!live) return () => { alive = false }
    const id = setInterval(load, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [feature, live])

  if (runs.length === 0) return null
  return (
    <div data-testid="feature-runs">
      <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        Runs
      </h3>
      <ul className="m-0 flex list-none flex-col gap-1 rounded border p-1" style={{ borderColor: 'var(--border-default)' }}>
        {runs.map((r) => (
          <RunRow key={r.runId} run={r} detail={details.get(r.runId)} onSelect={(run) => onOpenRun?.(feature, run.runId)} />
        ))}
      </ul>
    </div>
  )
}

/** The merged run row's live heart (R22): what is happening RIGHT NOW and what
 *  each repair cycle fixed — sourced from the run manifest + heal journal, not
 *  the agent's raw output. Polls gently while the run is active. */
function RunRepairSummary({ runId, active }: { runId: string; active: boolean }) {
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [journal, setJournal] = useState<JournalEntry[]>([])
  useEffect(() => {
    let alive = true
    const load = (): void => {
      api.getRunDetail(runId).then((d) => { if (alive) setDetail(d) }).catch(() => {})
      api.listJournal({ run: runId }).then((j) => { if (alive) setJournal(j) }).catch(() => {})
    }
    load()
    if (!active) return () => { alive = false }
    const id = setInterval(load, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [runId, active])

  const manifest = detail?.manifest
  const summary = detail?.summary
  const nowLine = !manifest || !active
    ? null
    : manifest.status === 'healing'
      ? `Repairing — cycle ${(manifest.healCycles ?? 0) + 1}`
      : summary?.running?.name
        ? `Running "${summary.running.name}"`
        : 'Running tests'
  const failing = summary?.failed ?? []
  const cycles = [...journal].sort((a, b) => (b.iteration ?? 0) - (a.iteration ?? 0)).slice(0, 3)
  // R46: the services this run booted — names + live status, straight from the
  // run manifest the run detail page reads.
  const services = (manifest?.services ?? []).map((svc) => `${svc.name} (${svc.status})`)

  if (!nowLine && failing.length === 0 && cycles.length === 0 && !summary) return null
  return (
    <div data-testid="run-repair-summary" className="flex flex-col gap-1.5">
      <FactsGrid facts={[
        ...(nowLine ? [{ label: 'Now', value: nowLine }] : []),
        ...(services.length > 0
          ? [{ label: 'Services', value: services.join(', '), mono: true }]
          : []),
        ...(summary && summary.total > 0
          ? [{ label: 'Tests', value: `${summary.passed}/${summary.total} passed`, tone: failing.length > 0 ? 'warn' as const : 'good' as const }]
          : []),
        ...(failing.length > 0
          ? [{
              label: 'Failing',
              value: `${failing.slice(0, 2).map((f) => f.name).join(', ')}${failing.length > 2 ? ` +${failing.length - 2} more` : ''}`,
              tone: 'bad' as const,
            }]
          : []),
      ]} />
      {/* R46: the run's own controls, right on the stage — same endpoints the
          run detail page drives; all state flows back over the runs WS. */}
      {manifest && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="run-stage-controls">
          {active && manifest.status === 'healing' && (
            <button
              type="button"
              data-testid="run-stage-cancel-heal"
              onClick={() => { api.cancelHealRun(runId).catch(() => {}) }}
              className="cl-button px-2 py-0.5 text-[11px]"
            >
              Cancel repair
            </button>
          )}
          {active && (
            <button
              type="button"
              data-testid="run-stage-stop"
              onClick={() => { api.stopRun(runId).catch(() => {}) }}
              className="cl-button px-2 py-0.5 text-[11px]"
              style={{ color: 'var(--danger)' }}
            >
              ⏹ Stop run
            </button>
          )}
          {!active && (manifest.status === 'failed' || manifest.status === 'aborted') && (
            <button
              type="button"
              data-testid="run-stage-restart"
              onClick={() => { api.restartRun(runId).catch(() => {}) }}
              className="cl-button px-2 py-0.5 text-[11px]"
              style={{ color: 'rgb(56, 189, 248)' }}
              title="Re-run the remaining/failed tests on the same run"
            >
              ▸ Restart run
            </button>
          )}
        </div>
      )}
      {cycles.length > 0 && (
        <div data-testid="repair-journal">
          <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Repairs</h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {cycles.map((entry) => (
              <li key={entry.iteration ?? entry.timestamp ?? entry.body.slice(0, 24)} className="text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
                <span style={{ color: entry.outcome === 'passed' ? 'rgb(52, 211, 153)' : 'var(--text-muted)' }}>
                  Cycle {entry.iteration ?? '?'}{entry.outcome ? ` · ${entry.outcome}` : ''}
                </span>
                {entry.hypothesis ? ` — ${truncate(entry.hypothesis, 90)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Evaluation Report's primary action (R15): the explicit download, in the
 *  header slot every stage reserves for its one action. */
function DownloadEvaluationAction({ flight, stage }: { flight: FlightManifest; stage: FlightStage }) {
  const { downloadTask } = useEvaluationExports()
  const [failed, setFailed] = useState(false)
  const ev = (stage.evidence ?? {}) as Record<string, unknown>
  const taskId = (typeof ev.taskId === 'string' ? ev.taskId : undefined) ?? flight.links?.evaluationTaskId
  const zip = (typeof ev.evaluationZip === 'string' ? ev.evaluationZip : undefined) ?? flight.links?.evaluationZip
  if (!taskId || !zip) return null
  return (
    <button
      type="button"
      data-testid="flight-download-evaluation"
      onClick={() => {
        setFailed(false)
        downloadTask(taskId).catch(() => setFailed(true))
      }}
      className="cl-button shrink-0 px-2.5 py-1 text-xs"
      style={{ color: failed ? 'var(--danger)' : 'rgb(52, 211, 153)' }}
    >
      {failed ? 'Download failed — retry' : '⬇ Download evaluation (.zip)'}
    </button>
  )
}

function CheckpointControls({
  flightId,
  flight,
  checkpoint,
  onResponded,
}: {
  flightId: string
  flight: FlightManifest
  checkpoint: FlightCheckpoint
  onResponded: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [envText, setEnvText] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const respond = (response: { choice?: string; values?: Record<string, string>; data?: unknown }): void => {
    setBusy(true)
    setFailure(null)
    api.respondFlightCheckpoint(flightId, response)
      .then(() => onResponded())
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const data = (checkpoint.data ?? {}) as Record<string, unknown>
  const missing = Array.isArray(data.missing) ? (data.missing as string[]) : []
  const diff = typeof data.diff === 'string' ? data.diff : null
  const configError = typeof data.error === 'string' ? data.error : null

  return (
    <section
      data-testid="checkpoint-controls"
      className="flex flex-col gap-2.5 rounded border p-3"
      style={{ borderColor: 'color-mix(in srgb, rgb(251, 191, 36) 45%, var(--border-default))' }}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true">⏸</span>
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'rgb(251, 191, 36)' }}>
          {checkpoint.kind}
        </span>
      </div>
      <p className="text-[12px]">{checkpoint.message}</p>

      {checkpoint.kind === 'prd-source' && (
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Add or link docs above (they land in features/{flight.feature}/docs/), then continue — or pick a source to infer from.
        </p>
      )}

      {checkpoint.kind === 'config-approval' && configError && (
        <p data-testid="checkpoint-config-error" className="text-[11px]" style={{ color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>
          {configError}
        </p>
      )}

      {diff && (
        <pre className="max-h-[280px] overflow-auto rounded border p-2 text-[10.5px]" style={{ borderColor: 'var(--border-default)', fontFamily: 'var(--font-mono)' }}>
          {diff}
        </pre>
      )}

      {checkpoint.kind === 'missing-env' && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Missing: {missing.join(', ')}
          </div>
          <textarea
            data-testid="checkpoint-env-values"
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={'KEY=value\nANOTHER_KEY=value'}
            spellCheck={false}
            rows={4}
            className="w-full rounded border p-2 text-[11px] outline-none"
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
          />
          <button
            type="button"
            data-testid="checkpoint-submit-values"
            disabled={busy || !envText.trim()}
            onClick={() => {
              const values: Record<string, string> = {}
              for (const line of envText.split('\n')) {
                const eq = line.indexOf('=')
                if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
              }
              respond({ values })
            }}
            className="cl-button self-start px-2.5 py-1 text-xs"
          >
            Submit values
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {(checkpoint.options ?? []).map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`checkpoint-choice-${option}`}
            disabled={busy}
            onClick={() => respond({ choice: option })}
            className="cl-button px-2.5 py-1 text-xs"
            style={option === (checkpoint.options ?? [])[0] ? { color: 'rgb(56, 189, 248)' } : undefined}
          >
            {option}
          </button>
        ))}
      </div>

      {failure && <div className="text-[11px]" style={{ color: 'var(--danger)' }}>{failure}</div>}
    </section>
  )
}
