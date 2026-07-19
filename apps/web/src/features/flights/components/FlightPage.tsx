import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as api from '../../../shared/api/client'
import type {
  FlightCheckpoint,
  FlightManifest,
  FlightStage,
  FlightStageKey,
  SpecsCoverageProgress as SpecsCoverageProgressT,
} from '../../../shared/api/client'
import type { ExternalHealSession, JournalEntry, RunDetail, RunIndexEntry } from '../../../shared/api/types'
import { AgentSessionView, type AgentSessionSource } from '../../agent-sessions/components/AgentSessionView'
import { StatusDot } from '../../config/components/atoms'
import { useEvaluationExports } from '../../evaluation/state/EvaluationExportContext'
import { RunRow } from '../../runs/components/RunRow'
import { clientLabel } from '../../runs/components/external-client-branding'
import { FLIGHT_STATUS_TONE, flightStatusLabel } from './FlightsPill'
import { FeatureSetupPanel, FlightDocsPanel, RepoScanPanel } from './FlightStagePanels'
import { useInvalidationKey } from '../../../shared/state/invalidation'
import type { FeatureActivity } from '../state/feature-activity'
import {
  FactsGrid,
  STAGE_BLURB,
  STAGE_COMPANION,
  STAGE_ICON,
  StageStatusChip,
  checkpointOptionLabel,
  checkpointTitle,
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
// the real surfaces behind the drill-through. The flights *list* is the picker
// dialog (FlightsPickerDialog, `?view=flights` with no flight) — this view only
// renders a selected flight. Live via `flights-changed` events (refreshKey) + a
// gentle poll while the flight is active.

/** Stage key → the sidecar dir its adapter pins an agent-session ref into.
 *  Stages without an agent (similarity, scaffold, run…) have no entry. */
const AGENT_STAGE_DIRS: Partial<Record<FlightStageKey, string>> = {
  'scout': 'scout',
  'prd-summary': 'prd-summary',
  'specs-coverage': 'specs-coverage',
}

/** The `[external]` activity-rail line for the run stage when its heal was
 *  claimed by an external MCP client (Claude Desktop / Codex) — the honest
 *  "this repair runs in your own window" indicator. An external agent's
 *  transcript never reaches Canary (Canary is only the MCP server it calls), so
 *  this is a status row (client · state · cycle), never a mirrored timeline. The
 *  full picture is one drill-through away on the run detail's External panel. */
export function externalHealSystemLine(session: ExternalHealSession): string {
  const who = clientLabel(session.clientKind, 'an external client')
  const cycle = session.cycleCount > 0 ? ` · repair cycle ${session.cycleCount}` : ''
  return `[external] Heal claimed by ${who} — ${session.status}${cycle}`
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
  onSelectFlight,
  onClose,
  activity,
  onStartFlight,
  onOpenConfig,
  onOpenRun,
  onOpenCoverage,
  onOpenPortify,
}: {
  flightId: string
  /** Back to the flights picker (null clears the selected flight). */
  onSelectFlight: (flightId: string | null) => void
  onClose: () => void
  /** Per-feature live activity (runs / portify / authoring) — App owns it. */
  activity?: Map<string, FeatureActivity>
  /** Opens the stage-entry launcher for the flight's feature (R25 re-fly). */
  onStartFlight?: (feature: string) => void
  /** Opens FeatureConfigEditor — the Feature Setup panel's Advanced setup. */
  onOpenConfig?: (feature: string) => void
} & FlightDrillThroughs) {
  // The flight detail refetches on `flights-changed`; the setup digest on
  // `features-changed` (repos); the Requirements docs list on `coverage-changed`.
  const refreshKey = useInvalidationKey('flights')
  const configRefreshKey = useInvalidationKey('repos')
  const docsRefreshKey = useInvalidationKey('coverage')
  return (
    <div className="flex h-full w-full flex-col" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <FlightDetail flightId={flightId} refreshKey={refreshKey} onClose={onClose} onBackToList={() => onSelectFlight(null)} onStartFlight={onStartFlight} onOpenConfig={onOpenConfig} configRefreshKey={configRefreshKey} docsRefreshKey={docsRefreshKey} activity={activity} drill={{ onOpenRun, onOpenCoverage, onOpenPortify }} />
    </div>
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
  // R71/W1: one inline error line under the header — every header/run control
  // failure lands here instead of a silent `.catch(() => {})`.
  const [actionError, setActionError] = useState<string | null>(null)

  const refetch = useCallback((): void => {
    api.getFlight(flightId)
      .then((m) => { setFlight(m); setError(null) })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [flightId])

  /** Fire a flight control call: refetch on success, surface failure inline. */
  const act = useCallback((call: () => Promise<unknown>, onSuccess?: () => void): void => {
    setActionError(null)
    call()
      .then(() => { (onSuccess ?? refetch)() })
      .catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)))
  }, [refetch])

  // R71/W1: Escape is the keyboard exit to the workspace (the Close button is
  // gone — the breadcrumb + Flights pill cover pointer navigation).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // "Respond →": return selection to follow-mode (auto-pick lands on the parked
  // stage) and bring its checkpoint card into view.
  const respondJump = useCallback((): void => {
    setSelectedStage(null)
    requestAnimationFrame(() => {
      document.querySelector('[data-testid="checkpoint-controls"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [])

  // R71/W2: switching flights returns selection to follow-mode — a stage pick
  // made on flight A must not survive onto flight B.
  useEffect(() => { setSelectedStage(null) }, [flightId])

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
  const evalStage = flight.stages.find((s) => s.key === 'evaluation-export') ?? null
  return (
    <>
      <header className="flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--border-default)' }}>
        {/* R71/W1: the title IS the breadcrumb — "Flights" links back to the
            picker (the always-visible Flights pill is the second way back), so
            navigation costs no button. Controls are exactly one state-dependent
            primary + the ⋯ menu — 2 buttons max in every state. */}
        {/* R72: one line answers "which flight, what state" — breadcrumb,
            name, chip, side by side. Repos + intent live on the Repo scan
            stage. */}
        <h1 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          <button
            type="button"
            data-testid="flight-breadcrumb"
            onClick={onBackToList}
            className="shrink-0 font-normal underline-offset-2 transition-colors hover:underline"
            style={{ color: 'var(--text-muted)' }}
            title="All flights"
          >
            Flights
          </button>
          <span aria-hidden="true" className="shrink-0 font-normal" style={{ color: 'var(--text-muted)' }}>/</span>
          <span className="truncate">🕊️ {flight.feature}</span>
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
        </h1>
        {/* The one primary: the state's obvious next action. Running has none —
            nothing demands a click, so nothing shouts. */}
        {flight.status === 'waiting-for-approval' && (
          <button
            type="button"
            data-testid="flight-primary-respond"
            onClick={respondJump}
            className="cl-button-primary px-2.5 py-1 text-xs"
            title="Jump to the question the flight is waiting on"
          >
            Respond →
          </button>
        )}
        {flight.status === 'paused' && (
          <button
            type="button"
            data-testid="flight-resume"
            onClick={() => act(() => api.resumeFlight(flightId))}
            className="cl-button-primary px-2.5 py-1 text-xs"
          >
            Continue
          </button>
        )}
        {flight.status === 'done' && evalStage && (
          <DownloadEvaluationAction flight={flight} stage={evalStage} testId="flight-primary-download" primary />
        )}
        {(flight.status === 'failed' || flight.status === 'aborted') && onStartFlight && (
          <button
            type="button"
            data-testid="flight-refly"
            onClick={() => onStartFlight(flight.feature)}
            className="cl-button-primary px-2.5 py-1 text-xs"
          >
            Repeat a step…
          </button>
        )}
        <FlightMenu flight={flight} onAction={act} onStartFlight={onStartFlight} onDeleted={onBackToList} />
      </header>
      {actionError && (
        <div
          data-testid="flight-action-error"
          className="flex items-center gap-2 border-b px-4 py-1.5 text-[11px]"
          style={{ borderColor: 'var(--border-default)', color: 'var(--danger)' }}
        >
          <span className="min-w-0 flex-1 truncate" title={actionError}>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="cl-button shrink-0 px-2 py-0.5 text-[10.5px]">Dismiss</button>
        </div>
      )}

      <FlightSummaryStrip flight={flight} onSelectStage={setSelectedStage} />

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Flight stages"
          className="flex w-[240px] shrink-0 flex-col gap-0.5 overflow-auto border-r p-2 scrollbar-thin"
          style={{ borderColor: 'var(--border-default)', scrollbarGutter: 'stable' }}
        >
          {/* R72: follow-mode is a corner whisper, not a control bar — a muted
              "following" while auto-select tracks the action, a quiet "↩ follow"
              text link once a manual pick parks it. Never a peer of Continue. */}
          <div className="flex items-baseline justify-between px-2 pb-1">
            <span className="text-[9.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Stages
            </span>
            {selectedStage === null ? (
              <span
                data-testid="rail-following"
                className="text-[9.5px]"
                style={{ color: 'var(--text-muted)' }}
                title="Selection follows the stage that needs eyes"
              >
                following ⦿
              </span>
            ) : (
              <button
                type="button"
                data-testid="rail-resume-follow"
                onClick={() => setSelectedStage(null)}
                className="text-[9.5px] underline-offset-2 transition-colors hover:underline"
                style={{ color: 'rgb(56, 189, 248)' }}
                title="Return to auto-selecting the stage that needs eyes"
              >
                ↩ follow
              </button>
            )}
          </div>
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
                title={STAGE_BLURB[s.key]}
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
            <StageDetail key={stage.key} flightId={flightId} flight={flight} row={row} stage={stage} companion={companionStage} runLive={runLive} onResponded={refetch} onActionError={setActionError} onOpenConfig={onOpenConfig} configRefreshKey={configRefreshKey} docsRefreshKey={docsRefreshKey} drill={drill} />
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

/** R73: the one failure card every stage renders when it fails — a danger-toned
 *  twin of CheckpointControls, so a crash reads with the same weight as a
 *  checkpoint instead of a bare red line. Names what failed and shows the raw
 *  detail in a scrollable mono block (these messages run long). Recovery is the
 *  header's state primary (Continue / Repeat a step…), not a second button here
 *  — one Continue, no confusion. Width is capped to line up with the repo-scan
 *  cards above (both ~76ch) so the stage reads as one column, not a full-bleed
 *  banner under narrow cards. */
function StageErrorPanel({ stageLabel, detail }: {
  stageLabel: string
  detail: string
}) {
  return (
    <section
      data-testid="stage-error"
      className="flex w-full max-w-[76ch] flex-col gap-2.5 rounded border p-3"
      style={{
        borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border-default))',
        background: 'color-mix(in srgb, var(--danger) 6%, transparent)',
      }}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" style={{ color: 'var(--danger)' }}>✕</span>
        <span data-testid="stage-error-title" className="text-[12.5px] font-semibold" style={{ color: 'var(--danger)' }}>
          {stageLabel} failed
        </span>
      </div>
      <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        The step stopped on the error below. Resolve the cause if needed, then Continue from the header to retry.
      </p>
      <pre
        data-testid="stage-error-detail"
        className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded border p-2 text-[10.5px]"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
      >
        {detail}
      </pre>
    </section>
  )
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
  onActionError,
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
  // The run detail behind the merged Run stage — one poll, shared by the repair
  // summary and the external-heal indicator below (don't fetch it twice).
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null)
  useEffect(() => {
    if (!runMerged || !runId) { setRunDetail(null); return }
    let alive = true
    const load = (): void => { api.getRunDetail(runId).then((d) => { if (alive) setRunDetail(d) }).catch(() => {}) }
    load()
    if (!live) return () => { alive = false }
    const id = setInterval(load, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [runMerged, runId, live])
  // R66/external: when a flight's run is being (or was) repaired by an external
  // MCP client, the run has no Canary-spawned heal session to tail — so instead
  // of a blank rail we surface an honest `[external]` status row at the head of
  // the activity band. Status only (an external agent's transcript never reaches
  // Canary); the full picture is one drill-through away on the run detail.
  const externalHeal = runDetail?.manifest?.healMode === 'external'
    ? runDetail.manifest.externalHealSession
    : undefined
  const leadingSystemRows = externalHeal ? [externalHealSystemLine(externalHeal)] : []
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
        <h2 className="text-[13px] font-semibold" title={STAGE_BLURB[stage.key]}>{row.label}</h2>
        <StageStatusChip status={row.status} />
        <div className="flex-1" />
        {stage.key === 'scaffold' && stage.status !== 'pending' && onOpenConfig && (
          <button
            type="button"
            data-testid="feature-setup-advanced"
            onClick={() => onOpenConfig(flight.feature)}
            className="cl-button shrink-0 px-2 py-0.5 text-[11px]"
          >
            ⚙ Advanced setup
          </button>
        )}
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
      <div data-testid="stage-state-line" className="max-w-[76ch] text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {stageStateLine(stage, flight, companion ?? undefined)}
      </div>

      <FactsGrid facts={facts} />

      {/* Repo scan (R72c): one intent card, then one repo card per inspected
          repo carrying its own location + env files. */}
      {stage.key === 'scout' && (
        <RepoScanPanel
          flight={flight}
          envFiles={(() => {
            const ev = (stage.evidence ?? {}) as Record<string, unknown>
            return Array.isArray(ev.envFiles) ? (ev.envFiles as unknown[]).filter((f): f is string => typeof f === 'string') : []
          })()}
        />
      )}

      {/* Suite setup (R43): the editable digest over the REAL on-disk config
          — same doc Advanced setup (FeatureConfigEditor) edits, live both
          ways. The Advanced setup button rides the stage header above. */}
      {stage.key === 'scaffold' && stage.status !== 'pending' && (
        <FeatureSetupPanel
          feature={flight.feature}
          editable={flight.status !== 'running'}
          refreshKey={configRefreshKey}
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
      {runMerged && runId && <RunRepairSummary runId={runId} detail={runDetail} active={live} onError={onActionError} />}

      {/* Test Run (R64): every run this feature has had, as the same cards the
          runs list renders — click drills into the real run detail. */}
      {runMerged && row.status !== 'pending' && (
        <FeatureRunsPanel feature={flight.feature} live={Boolean(runLive) || live} onOpenRun={drill.onOpenRun} />
      )}

      {/* Test authoring & coverage (R27): the author↔map loop as a pass
          timeline — coverage % after each mapping feeds the next authoring. */}
      {loopProgress && <SpecsPassTimeline progress={loopProgress} live={live} />}

      {(row.status === 'failed' && error) && (
        <StageErrorPanel stageLabel={row.label} detail={error} />
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
        leadingSystemRows={leadingSystemRows}
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
  leadingSystemRows = [],
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
  /** Extra system rows pinned at the very head of the rail, before the
   *  conductor's log — e.g. the `[external]` row when the run is being repaired
   *  by an external MCP client (no Canary session to tail). */
  leadingSystemRows?: string[]
}) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const lines = log.split('\n').filter((l) => l.trim() !== '')
  const hasSource = source !== undefined
  // A stage that hasn't started (pending — neither live nor settled) has no
  // activity to show. Suppress the whole rail when there's nothing real yet,
  // even for an agent stage whose `source` exists but has no session: otherwise
  // pending agent stages render an empty "No structured session log found" band
  // while pending agentless stages render nothing — the same waiting stage, two
  // different empty states. Once it's live or settled the rail always shows
  // (the live timeline, or the settled disclosure).
  const pending = !live && !settled
  const nothingYet = lines.length === 0 && leadingSystemRows.length === 0
  if (nothingYet && (!hasSource || pending)) return null
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
          One labelled bar for every stage; the toggle always rides it so the
          rail is collapsible in any state (default open while live / a fresh
          spawn, collapsed once settled — overridable per stage). */}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <button
          type="button"
          data-testid="stage-details-toggle"
          aria-expanded={open}
          onClick={() => setUserToggled(!open)}
          className="flex flex-1 items-center gap-2.5 text-left"
        >
          <span className="text-[10px] font-semibold uppercase tracking-[0.11em]" style={{ color: 'var(--text-muted)' }}>
            Activity
          </span>
          <span className="h-px flex-1" style={{ borderTop: '1px dashed var(--border-default)' }} />
          <span className="cl-button px-2 py-0.5 text-[11px]">
            {open ? '▾ Hide' : '▸ Show'}
          </span>
        </button>
      </div>
      {open && (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          {/* ONE rail for EVERY stage. The conductor's system lines and the
              stage's agent timeline (flight agent, or the export task) share it;
              an agentless stage (no `source`) renders system rows alone. */}
          <AgentBlock>
            <AgentSessionView key={sourceKey} source={source} systemRows={{ pre: [...leadingSystemRows, ...pre], post }} />
          </AgentBlock>
        </div>
      )}
    </section>
  )
}

/** R71/W1: the header's ⋯ menu — every non-primary control, state-filtered so
 *  each item appears only where it applies. Destructive items (Stop flight /
 *  Start over / Delete flight) keep their two-step confirm INSIDE the menu:
 *  first click arms the item in place, second click fires; closing the menu
 *  disarms. Errors route to the header's inline error line via onAction. */
function FlightMenu({
  flight,
  onAction,
  onStartFlight,
  onDeleted,
}: {
  flight: FlightManifest
  onAction: (call: () => Promise<unknown>, onSuccess?: () => void) => void
  onStartFlight?: (feature: string) => void
  onDeleted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) { setArmed(null); return }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const active = flight.status === 'running' || flight.status === 'waiting-for-approval'
  const settledByFailure = flight.status === 'failed' || flight.status === 'aborted'
  const id = flight.flightId

  interface MenuItem {
    key: string
    label: string
    /** Present → two-step: first click arms with this label, second fires. */
    confirmLabel?: string
    tone?: string
    title?: string
    testId: string
    fire: () => void
  }
  const items: MenuItem[] = [
    ...(active
      ? [{
          key: 'pause',
          label: '⏸ Pause',
          title: 'Pause the flight — in-flight stage work stops safely; Continue resumes it',
          testId: 'flight-pause',
          fire: () => onAction(() => api.pauseFlight(id)),
        }]
      : []),
    // Repeat a step… lives ONLY here (except failed/aborted, where re-flying is
    // the header primary — no duplicate menu entry there).
    ...(!active && !settledByFailure && onStartFlight
      ? [{
          key: 'refly',
          label: 'Repeat a step…',
          testId: 'flight-refly',
          fire: () => onStartFlight(flight.feature),
        }]
      : []),
    ...(active
      ? [{
          key: 'abort',
          label: '⏹ Stop flight…',
          confirmLabel: 'Really stop?',
          tone: 'var(--danger)',
          title: 'Terminal: kills the run, frees the repo queue — Start over or a stage jump is the only redo',
          testId: 'flight-abort',
          fire: () => onAction(() => api.abortFlight(id)),
        }]
      : []),
    ...(!active
      ? [{
          key: 'redo',
          label: '↺ Start over…',
          confirmLabel: 'Really start over?',
          tone: 'rgb(251, 191, 36)',
          title: 'Restart this flight from the beginning — stage records reset (artifacts on disk are kept and reused)',
          testId: 'flight-start-over',
          fire: () => onAction(() => api.redoFlight(id)),
        }]
      : []),
    ...(!active
      ? [{
          key: 'delete',
          label: 'Delete flight…',
          confirmLabel: 'Really delete?',
          tone: 'var(--danger)',
          title: 'Delete this flight record — the feature stays and reads as idle (its rail keeps the evidence-derived progress)',
          testId: 'flight-delete',
          fire: () => onAction(() => api.deleteFlight(id), onDeleted),
        }]
      : []),
  ]

  if (items.length === 0) return null
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        data-testid="flight-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Flight actions"
        onClick={() => setOpen((v) => !v)}
        className="cl-button px-2.5 py-1 text-xs"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 flex min-w-[172px] flex-col rounded border p-1"
          style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-menu, 0 4px 16px rgba(0,0,0,.35))' }}
        >
          {items.map((item) => {
            const isArmed = armed === item.key
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                data-testid={isArmed ? `${item.testId}-confirm` : item.testId}
                title={item.title}
                onClick={() => {
                  if (item.confirmLabel && !isArmed) { setArmed(item.key); return }
                  setOpen(false)
                  item.fire()
                }}
                className="rounded px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.05]"
                style={{ color: item.tone }}
              >
                {isArmed ? item.confirmLabel : item.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** The header's summary strip (R61, R71/W5): the flight's headline numbers —
 *  elapsed wall-clock (live 1s tick while running), coverage %, run verdict,
 *  doc count, report readiness — derived from the manifest; items that don't
 *  exist yet simply don't render. Each stage-backed item is a jump: clicking
 *  Coverage/Run/Docs/Report selects that stage in the rail. */
function FlightSummaryStrip({
  flight,
  onSelectStage,
}: {
  flight: FlightManifest
  onSelectStage?: (key: FlightStageKey) => void
}) {
  const items: Array<{ label: string; value: string; tone?: string; stage?: FlightStageKey }> = []

  // R71/W5: the one state where you'd watch the clock used to be the one state
  // that hid it — tick locally while the flight runs.
  const live = !flight.endedAt && flight.status === 'running'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])
  const elapsed = formatDuration(flight.createdAt, flight.endedAt ?? (live ? new Date(now).toISOString() : flight.updatedAt))
  if (elapsed) {
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
      stage: 'specs-coverage',
    })
  }

  if (flight.runVerdict) {
    items.push({
      label: 'Run',
      value: flight.runVerdict,
      tone: flight.runVerdict === 'passed' ? 'rgb(52, 211, 153)' : flight.runVerdict === 'failed' ? 'var(--danger)' : 'var(--text-muted)',
      stage: 'run',
    })
  }

  const docsEv = asRecord(flight.stages.find((s) => s.key === 'docs')?.evidence)
  const docs = Array.isArray(docsEv?.docs) ? docsEv.docs.length : 0
  if (docs > 0) items.push({ label: 'Docs', value: String(docs), stage: 'docs' })

  if (flight.links?.evaluationZip) items.push({ label: 'Report', value: 'ready', tone: 'rgb(52, 211, 153)', stage: 'evaluation-export' })

  if (items.length === 0) return null
  return (
    <div
      data-testid="flight-summary-strip"
      className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b px-4 py-1.5"
      style={{ borderColor: 'var(--border-default)' }}
    >
      {items.map((item) => {
        const body = (
          <>
            <span className="text-[9.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              {item.label}
            </span>
            <span style={{ color: item.tone ?? 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{item.value}</span>
          </>
        )
        return item.stage && onSelectStage ? (
          <button
            key={item.label}
            type="button"
            data-testid={`strip-${item.stage}`}
            onClick={() => onSelectStage(item.stage!)}
            className="flex items-baseline gap-1.5 rounded text-[11px] underline-offset-2 transition-colors hover:underline"
            title={`Jump to ${stageRailLabelFor(item.stage)}`}
          >
            {body}
          </button>
        ) : (
          <span key={item.label} data-testid="strip-elapsed" className="flex items-baseline gap-1.5 text-[11px]">
            {body}
          </span>
        )
      })}
    </div>
  )
}

/** The rail row label a strip jump lands on (merged-pair aware). */
function stageRailLabelFor(key: FlightStageKey): string {
  if (key === 'run') return 'Test Run'
  if (key === 'docs') return 'Requirements'
  return key === 'specs-coverage' ? 'Test authoring & coverage' : 'Evaluation Report'
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
function RunRepairSummary({ runId, detail, active, onError }: { runId: string; detail: RunDetail | null; active: boolean; onError?: (msg: string) => void }) {
  const report = (err: unknown): void => onError?.(err instanceof Error ? err.message : String(err))
  const [journal, setJournal] = useState<JournalEntry[]>([])
  useEffect(() => {
    let alive = true
    const load = (): void => {
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
              onClick={() => { api.cancelHealRun(runId).catch(report) }}
              className="cl-button px-2 py-0.5 text-[11px]"
            >
              Cancel repair
            </button>
          )}
          {active && (
            <button
              type="button"
              data-testid="run-stage-stop"
              onClick={() => { api.stopRun(runId).catch(report) }}
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
              onClick={() => { api.restartRun(runId).catch(report) }}
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

/** Evaluation Report's primary action (R15): the explicit download — in the
 *  stage's action slot, and (R71/W1, `primary`) as the done-state header
 *  primary. Header and stage instances carry distinct testIds. */
function DownloadEvaluationAction({
  flight,
  stage,
  testId = 'flight-download-evaluation',
  primary = false,
}: {
  flight: FlightManifest
  stage: FlightStage
  testId?: string
  primary?: boolean
}) {
  const { downloadTask } = useEvaluationExports()
  const [failed, setFailed] = useState(false)
  const ev = (stage.evidence ?? {}) as Record<string, unknown>
  const taskId = (typeof ev.taskId === 'string' ? ev.taskId : undefined) ?? flight.links?.evaluationTaskId
  const zip = (typeof ev.evaluationZip === 'string' ? ev.evaluationZip : undefined) ?? flight.links?.evaluationZip
  if (!taskId || !zip) return null
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => {
        setFailed(false)
        downloadTask(taskId).catch(() => setFailed(true))
      }}
      className={`${primary ? 'cl-button-primary' : 'cl-button'} shrink-0 px-2.5 py-1 text-xs`}
      style={primary ? undefined : { color: failed ? 'var(--danger)' : 'rgb(52, 211, 153)' }}
    >
      {failed ? 'Download failed — retry' : primary ? '⬇ Download report' : '⬇ Download evaluation (.zip)'}
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

  // R71/W3: options render in outcome language (display map — the POSTed key
  // stays raw). The first option is the recommended default; past 3 options the
  // rest fold behind a disclosure so a fork never reads as a wall of buttons.
  const options = checkpoint.options ?? []
  const [showAllOptions, setShowAllOptions] = useState(false)
  const folded = options.length > 3 && !showAllOptions
  const visibleOptions = folded ? options.slice(0, 1) : options

  return (
    <section
      data-testid="checkpoint-controls"
      className="flex w-full max-w-[76ch] flex-col gap-2.5 rounded border p-3"
      style={{ borderColor: 'color-mix(in srgb, rgb(251, 191, 36) 45%, var(--border-default))' }}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" style={{ color: 'rgb(251, 191, 36)' }}>⏸</span>
        <span
          data-testid="checkpoint-title"
          className="text-[12.5px] font-semibold"
          title={checkpoint.kind}
        >
          {checkpointTitle(checkpoint.kind)}
        </span>
      </div>
      <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{checkpoint.message}</p>

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

      <div className="flex flex-wrap items-center gap-1.5">
        {visibleOptions.map((option, i) => (
          <button
            key={option}
            type="button"
            data-testid={`checkpoint-choice-${option}`}
            disabled={busy}
            onClick={() => respond({ choice: option })}
            className="cl-button inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"
            title={option}
            style={i === 0
              ? { color: 'rgb(56, 189, 248)', borderColor: 'color-mix(in srgb, rgb(56, 189, 248) 45%, var(--border-default))' }
              : undefined}
          >
            {checkpointOptionLabel(checkpoint.kind, option)}
            {i === 0 && (
              /* R71/W3: the default is named, not color-only. */
              <span
                data-testid="checkpoint-recommended"
                className="rounded border px-1 py-px text-[9px] font-semibold uppercase tracking-wide"
                style={{ borderColor: 'color-mix(in srgb, rgb(56, 189, 248) 45%, transparent)' }}
              >
                Recommended
              </span>
            )}
          </button>
        ))}
        {folded && (
          <button
            type="button"
            data-testid="checkpoint-more-options"
            disabled={busy}
            onClick={() => setShowAllOptions(true)}
            className="cl-button px-2.5 py-1 text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            More options ▾
          </button>
        )}
      </div>

      {failure && <div className="text-[11px]" style={{ color: 'var(--danger)' }}>{failure}</div>}
    </section>
  )
}
