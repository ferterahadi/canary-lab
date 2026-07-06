import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from '../../../shared/api/client'
import type {
  FlightCheckpoint,
  FlightIndexEntry,
  FlightManifest,
  FlightStage,
  FlightStageKey,
  SpecsCoverageProgress as SpecsCoverageProgressT,
} from '../../../shared/api/client'
import type { JournalEntry, RunDetail } from '../../../shared/api/types'
import { AgentSessionView } from '../../agent-sessions/components/AgentSessionView'
import { StatusDot } from '../../config/components/atoms'
import { useEvaluationExports } from '../../evaluation/state/EvaluationExportContext'
import { ActivityOnlyRow, FLIGHT_STATUS_TONE, FlightStatusChip, StageMiniRail, featureActivityRows, flightStatusLabel } from './FlightsPill'
import type { FeatureActivity } from '../state/feature-activity'
import {
  FactsGrid,
  STAGE_ICON,
  StageStatusChip,
  specsCoverageProgress,
  stageFacts,
  stageRailRows,
  stageStateLine,
  stageStatusTone,
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
  onOpenActivity,
  onStartFlight,
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
  /** Open the real surface behind an activity-only landing row. */
  onOpenActivity?: (feature: string, activity: FeatureActivity) => void
  /** Opens the stage-entry launcher for the flight's feature (R25 re-fly). */
  onStartFlight?: (feature: string) => void
} & FlightDrillThroughs) {
  return (
    <div className="flex h-full w-full flex-col" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      {flightId
        ? <FlightDetail flightId={flightId} refreshKey={refreshKey} onClose={onClose} onBackToList={() => onSelectFlight(null)} onStartFlight={onStartFlight} drill={{ onOpenRun, onOpenCoverage, onOpenPortify }} />
        : <FlightsLanding refreshKey={refreshKey} activity={activity} onSelectFlight={onSelectFlight} onOpenActivity={onOpenActivity} onClose={onClose} />}
    </div>
  )
}

function FlightsLanding({
  refreshKey,
  activity = new Map(),
  onSelectFlight,
  onOpenActivity,
  onClose,
}: {
  refreshKey: number
  activity?: Map<string, FeatureActivity>
  onSelectFlight: (flightId: string) => void
  onOpenActivity?: (feature: string, activity: FeatureActivity) => void
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
      {flights.length === 0 && activity.size === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
          No flights yet — start one from a terminal and it appears here live.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5 overflow-auto p-3 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
          {featureActivityRows(flights, activity).map((row) => (
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
              ) : (
                <ActivityOnlyRow feature={row.feature} activity={row.activity!} onOpen={(f, a) => onOpenActivity?.(f, a)} />
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
  drill,
}: {
  flightId: string
  refreshKey: number
  onBackToList: () => void
  onClose: () => void
  onStartFlight?: (feature: string) => void
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
  const railRows = useMemo(() => (flight ? stageRailRows(flight.stages) : []), [flight])

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
  const healStage = flight?.stages.find((s) => s.key === 'heal') ?? null

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
        <button type="button" onClick={onBackToList} aria-label="All flights" className="cl-button px-2 py-1 text-xs">←</button>
        {/* R17: the title answers "what is this?" alone on its own line; the
            status chip gets its own slot on the line below so "is it done?"
            never competes with the name. */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">🕊️ {flight.feature}</h1>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <span
              data-testid="flight-status"
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
        {/* R25: a settled flight offers the stage-entry launcher — repeat any
            step whose prerequisites hold, without leaving for a terminal. */}
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
            Resume
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
            Abort
          </button>
        )}
        <button type="button" onClick={onClose} className="cl-button px-2.5 py-1 text-xs">Close</button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Flight stages"
          className="flex w-[240px] shrink-0 flex-col gap-0.5 overflow-auto border-r p-2 scrollbar-thin"
          style={{ borderColor: 'var(--border-default)', scrollbarGutter: 'stable' }}
        >
          {railRows.map((s) => {
            const selected = s.key === stageKey
            const t = stageStatusTone(s.status)
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
                {s.status === 'running' && <StatusDot state="running" className="shrink-0" />}
              </button>
            )
          })}
        </nav>

        <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-3 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
          {!stage || !row ? (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Pick a stage.</div>
          ) : (
            <StageDetail key={stage.key} flightId={flightId} flight={flight} row={row} stage={stage} heal={healStage} onResponded={refetch} drill={drill} />
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
  if ((stage.key === 'specs-coverage' || stage.key === 'prd-summary') && drill.onOpenCoverage && stage.status !== 'pending') {
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
//   5. the agent's live output ONLY while it is working (never for test runs)
//   6. ▸ View details — evidence/log audit trail + historical agent timeline
function StageDetail({
  flightId,
  flight,
  row,
  stage,
  heal,
  onResponded,
  drill,
}: {
  flightId: string
  flight: FlightManifest
  row: StageRailRow
  stage: FlightStage
  heal: FlightStage | null
  onResponded: () => void
  drill: FlightDrillThroughs
}) {
  // R27: the specs↔coverage loop runs TWO agents per pass — the authoring
  // agent (sidecar `specs-coverage`) and the mapping agent (`coverage-map`).
  // The live view follows whichever half of the loop is working now.
  const loopProgress = specsCoverageProgress(stage)
  const agentDir =
    loopProgress && stage.status === 'running' && loopProgress.phase === 'mapping'
      ? 'coverage-map'
      : AGENT_STAGE_DIRS[stage.key]
  const merged = stage.key === 'run'
  const live = row.status === 'running'
  const settled = row.status === 'done' || row.status === 'failed'
  const facts = stageFacts(stage, flight, heal ?? undefined)
  const drillThrough = stageDrillThrough(stage, flight, drill)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const runId = merged
    ? (((stage.evidence as Record<string, unknown> | undefined)?.runId as string | undefined) ?? flight.links?.runId)
    : undefined
  const checkpointStage = stage.status === 'waiting-for-approval' ? stage : null
  const error = stage.error ?? heal?.error
  const hasDetails = stage.evidence !== undefined || Boolean(stage.log) || Boolean(merged && heal?.evidence !== undefined) || Boolean(agentDir && settled)

  return (
    <>
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
        {stageStateLine(stage, flight)}
      </div>

      <FactsGrid facts={facts} />

      {/* Test run & auto-repair (R22): what's running now, what each repair
          cycle fixed — no agent output, the run detail page holds the rest. */}
      {merged && runId && <RunRepairSummary runId={runId} active={live} />}

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

      {/* The agent's live output, only while it works — a settled stage answers
          with facts; the historical timeline lives behind View details. */}
      {agentDir && live && (
        <AgentBlock>
          {/* Keyed by sidecar so the loop's authoring→mapping swap remounts
              the timeline onto the other agent's stream. */}
          <AgentSessionView key={agentDir} source={{ kind: 'flight', flightId, stage: agentDir, live: true }} />
        </AgentBlock>
      )}

      {hasDetails && (
        <section>
          <button
            type="button"
            data-testid="stage-details-toggle"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
            className="cl-button px-2 py-0.5 text-[11px]"
          >
            {detailsOpen ? '▾ Hide details' : '▸ View details'}
          </button>
          {detailsOpen && (
            <div className="mt-2 flex flex-col gap-2">
              {agentDir && settled && (
                <AgentBlock>
                  <AgentSessionView source={{ kind: 'flight', flightId, stage: agentDir, live: false }} />
                </AgentBlock>
              )}
              {stage.evidence !== undefined && (
                <div>
                  <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Evidence</h3>
                  <pre className="overflow-auto rounded border p-2 text-[10.5px]" style={{ borderColor: 'var(--border-default)', fontFamily: 'var(--font-mono)', maxHeight: 220 }}>
                    {JSON.stringify(merged && heal?.evidence !== undefined ? { run: stage.evidence, repair: heal.evidence } : stage.evidence, null, 2)}
                  </pre>
                </div>
              )}
              {stage.log && (
                <div>
                  <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Log</h3>
                  <pre className="overflow-auto whitespace-pre-wrap rounded border p-2 text-[10.5px]" style={{ borderColor: 'var(--border-default)', fontFamily: 'var(--font-mono)', maxHeight: 260 }}>
                    {stage.log}
                  </pre>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </>
  )
}

/** Frame for a live agent timeline. Flight agents are canary-spawned on this
 *  server; the caption says so before showing what they're doing. */
function AgentBlock({ children }: { children: ReactNode }) {
  return (
    <section className="flex min-h-[240px] flex-1 flex-col gap-1">
      <span data-testid="agent-origin" className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        Agent · canary-spawned on this server
      </span>
      <div className="flex min-h-0 flex-1 flex-col rounded border" style={{ borderColor: 'var(--border-default)' }}>
        {children}
      </div>
    </section>
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

  if (!nowLine && failing.length === 0 && cycles.length === 0 && !summary) return null
  return (
    <div data-testid="run-repair-summary" className="flex flex-col gap-1.5">
      <FactsGrid facts={[
        ...(nowLine ? [{ label: 'Now', value: nowLine }] : []),
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

/** Export results' primary action (R15): the explicit download, in the header
 *  slot every stage reserves for its one action. */
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
  const [configSource, setConfigSource] = useState<string | null>(null)
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
  const draftConfig = typeof data.configSource === 'string' ? data.configSource : null
  const missing = Array.isArray(data.missing) ? (data.missing as string[]) : []
  const diff = typeof data.diff === 'string' ? data.diff : null

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
        <p className="text-[11px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          Drop docs into features/{flight.feature}/docs/ then choose retry — dropped docs win the hierarchy.
        </p>
      )}

      {draftConfig !== null && (
        <textarea
          data-testid="checkpoint-config"
          value={configSource ?? draftConfig}
          onChange={(e) => setConfigSource(e.target.value)}
          spellCheck={false}
          rows={Math.min(24, draftConfig.split('\n').length + 2)}
          className="w-full rounded border p-2 text-[11px] outline-none"
          style={{ borderColor: 'var(--border-default)', background: 'var(--bg-base)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
        />
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
            onClick={() => {
              const edited = configSource !== null && configSource !== draftConfig
              respond({ choice: option, ...(edited && option === 'approve' ? { data: { configSource } } : {}) })
            }}
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
