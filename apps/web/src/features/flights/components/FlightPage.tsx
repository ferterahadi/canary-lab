import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from '../../../shared/api/client'
import type {
  FlightCheckpoint,
  FlightIndexEntry,
  FlightManifest,
  FlightStage,
  FlightStageKey,
} from '../../../shared/api/client'
import type { RunDetail } from '../../../shared/api/types'
import { AgentSessionView } from '../../agent-sessions/components/AgentSessionView'
import { StatusDot } from '../../config/components/atoms'
import { useEvaluationExports } from '../../evaluation/state/EvaluationExportContext'
import { ExternalHealPanel } from '../../runs/components/ExternalHealPanel'
import { FLIGHT_STATUS_TONE, FlightStatusChip, StageMiniRail, flightStatusLabel } from './FlightsPill'
import { STAGE_ICON, StageStatusChip, stageLabel, stageStateLine, stageStatusTone } from './stage-meta'

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
  onOpenRun,
  onOpenCoverage,
  onOpenPortify,
}: {
  flightId: string | null
  refreshKey: number
  onSelectFlight: (flightId: string | null) => void
  onClose: () => void
} & FlightDrillThroughs) {
  return (
    <div className="flex h-full w-full flex-col" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      {flightId
        ? <FlightDetail flightId={flightId} refreshKey={refreshKey} onClose={onClose} onBackToList={() => onSelectFlight(null)} drill={{ onOpenRun, onOpenCoverage, onOpenPortify }} />
        : <FlightsLanding refreshKey={refreshKey} onSelectFlight={onSelectFlight} onClose={onClose} />}
    </div>
  )
}

function FlightsLanding({
  refreshKey,
  onSelectFlight,
  onClose,
}: {
  refreshKey: number
  onSelectFlight: (flightId: string) => void
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
      {flights.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
          No flights yet — start one from a terminal and it appears here live.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5 overflow-auto p-3 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
          {flights.map((f) => (
            <li key={f.flightId}>
              <button
                type="button"
                data-testid={`flight-row-${f.flightId}`}
                onClick={() => onSelectFlight(f.flightId)}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
                style={{ border: '1px solid var(--border-default)' }}
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{f.feature}</span>
                <span className="truncate text-[11px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {(f.repoPaths ?? []).join(', ')}
                </span>
                <StageMiniRail stages={f.stages ?? []} />
                <FlightStatusChip status={f.status} />
              </button>
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
  drill,
}: {
  flightId: string
  refreshKey: number
  onBackToList: () => void
  onClose: () => void
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

  // Default the selected stage to the one that needs eyes: waiting → running →
  // first failed → last done. The user's explicit pick wins.
  const autoStage = useMemo((): FlightStageKey | null => {
    if (!flight) return null
    const pick =
      flight.stages.find((s) => s.status === 'waiting-for-approval')
      ?? flight.stages.find((s) => s.status === 'running')
      ?? flight.stages.find((s) => s.status === 'failed')
      ?? [...flight.stages].reverse().find((s) => s.status === 'done')
    return pick?.key ?? null
  }, [flight])
  const stageKey = selectedStage ?? autoStage
  const stage = flight?.stages.find((s) => s.key === stageKey) ?? null

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
          {flight.stages.map((s) => {
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
                  {stageLabel(s.key)}
                </span>
                {s.status === 'running' && <StatusDot state="running" className="shrink-0" />}
              </button>
            )
          })}
        </nav>

        <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-3 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
          {!stage ? (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Pick a stage.</div>
          ) : (
            <StageDetail key={stage.key} flightId={flightId} flight={flight} stage={stage} onResponded={refetch} drill={drill} />
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

// The trailer (R16): each stage answers exactly three questions — where are we
// (the state line), what is the agent doing (origin + live output), can I see
// more (drill-through to the real surface, plus a collapsed details disclosure
// holding the raw evidence/log audit trail). Anything deeper belongs to the
// stage's own page, not here.
function StageDetail({
  flightId,
  flight,
  stage,
  onResponded,
  drill,
}: {
  flightId: string
  flight: FlightManifest
  stage: FlightStage
  onResponded: () => void
  drill: FlightDrillThroughs
}) {
  const agentDir = AGENT_STAGE_DIRS[stage.key]
  const settledOrLive = stage.status !== 'pending' && stage.status !== 'skipped'
  const showFlightAgent = Boolean(agentDir) && settledOrLive
  const runId = stage.key === 'run' || stage.key === 'heal'
    ? ((stage.evidence as Record<string, unknown> | undefined)?.runId as string | undefined) ?? flight.links?.runId
    : undefined
  const drillThrough = stageDrillThrough(stage, flight, drill)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const hasDetails = stage.evidence !== undefined || Boolean(stage.log)

  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-semibold" title={stage.key}>{stageLabel(stage.key)}</h2>
        <StageStatusChip status={stage.status} />
        <div className="flex-1" />
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

      {/* Q1 — where are we. One plain sentence, always present. */}
      <div data-testid="stage-state-line" className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {stageStateLine(stage, flight)}
      </div>

      {stage.status === 'failed' && stage.error && (
        <div className="rounded border px-2.5 py-2 text-[11.5px]" style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border-default))', color: 'var(--danger)' }}>
          {stage.error}
        </div>
      )}

      {stage.status === 'waiting-for-approval' && stage.checkpoint && (
        <CheckpointControls flightId={flightId} flight={flight} checkpoint={stage.checkpoint} onResponded={onResponded} />
      )}

      {/* Q2 — what is the agent doing. Origin is explicit: flight stages run
          canary-spawned agents; run/heal branches on the run's heal mode
          (external MCP client vs canary-spawned) like the run detail does. */}
      {showFlightAgent && agentDir && (
        <AgentBlock origin="canary">
          <AgentSessionView source={{ kind: 'flight', flightId, stage: agentDir, live: stage.status === 'running' }} />
        </AgentBlock>
      )}
      {(stage.key === 'run' || stage.key === 'heal') && settledOrLive && runId && (
        <RunHealAgentBlock runId={runId} live={stage.status === 'running'} />
      )}
      {stage.key === 'evaluation-export' && settledOrLive && (
        <EvaluationExportBlock flight={flight} stage={stage} />
      )}

      {/* Q3 — can I see more. The raw evidence/log audit trail, collapsed. */}
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
              {stage.evidence !== undefined && (
                <div>
                  <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Evidence</h3>
                  <pre className="overflow-auto rounded border p-2 text-[10.5px]" style={{ borderColor: 'var(--border-default)', fontFamily: 'var(--font-mono)', maxHeight: 220 }}>
                    {JSON.stringify(stage.evidence, null, 2)}
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

/** Shared frame for the Q2 agent slot: names who is acting before showing what
 *  they're doing. External surfaces (ExternalHealPanel) brand themselves. */
function AgentBlock({ origin, children }: { origin: 'canary'; children: ReactNode }) {
  return (
    <section className="flex min-h-[240px] flex-1 flex-col gap-1">
      <span data-testid="agent-origin" className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {origin === 'canary' ? 'Agent · canary-spawned on this server' : origin}
      </span>
      <div className="flex min-h-0 flex-1 flex-col rounded border" style={{ borderColor: 'var(--border-default)' }}>
        {children}
      </div>
    </section>
  )
}

/** Run/heal Q2: the repair agent's identity + output. External heal claim →
 *  the branded ExternalAgentCard surface (who is driving, in their own
 *  window); otherwise the canary-spawned heal agent's session timeline.
 *  Refetches on a gentle poll while live (the manifest's healMode /
 *  externalHealSession can appear mid-run). */
function RunHealAgentBlock({ runId, live }: { runId: string; live: boolean }) {
  const [detail, setDetail] = useState<RunDetail | null>(null)
  useEffect(() => {
    let alive = true
    const fetchDetail = (): void => {
      api.getRunDetail(runId).then((d) => { if (alive) setDetail(d) }).catch(() => {})
    }
    fetchDetail()
    if (!live) return () => { alive = false }
    const id = setInterval(fetchDetail, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [runId, live])

  if (!detail) return null
  const manifest = detail.manifest
  if (manifest.healMode === 'external') {
    return (
      <section data-testid="run-heal-external" className="flex flex-col">
        <ExternalHealPanel runId={runId} runStatus={manifest.status} session={manifest.externalHealSession} />
      </section>
    )
  }
  return (
    <AgentBlock origin="canary">
      <AgentSessionView source={{ kind: 'run', runId, live }} />
    </AgentBlock>
  )
}

/** Evaluation-export Q2 + the R15 consolidation: the export agent's output and
 *  an explicit download action live here — no standalone pill anywhere. */
function EvaluationExportBlock({ flight, stage }: { flight: FlightManifest; stage: FlightStage }) {
  const { downloadTask } = useEvaluationExports()
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const ev = (stage.evidence ?? {}) as Record<string, unknown>
  const taskId = (typeof ev.taskId === 'string' ? ev.taskId : undefined) ?? flight.links?.evaluationTaskId
  const zip = (typeof ev.evaluationZip === 'string' ? ev.evaluationZip : undefined) ?? flight.links?.evaluationZip

  return (
    <>
      {taskId && zip && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="flight-download-evaluation"
            onClick={() => {
              setDownloadError(null)
              downloadTask(taskId).catch((err: unknown) => setDownloadError(err instanceof Error ? err.message : String(err)))
            }}
            className="cl-button px-2.5 py-1 text-xs"
            style={{ color: 'rgb(52, 211, 153)' }}
          >
            ⬇ Download evaluation (.zip)
          </button>
          <span className="truncate text-[10.5px]" title={zip} style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {zip.split('/').pop()}
          </span>
          {downloadError && <span className="text-[11px]" style={{ color: 'var(--danger)' }}>{downloadError}</span>}
        </div>
      )}
      {taskId && (
        <AgentBlock origin="canary">
          <AgentSessionView source={{ kind: 'evaluation', taskId, live: stage.status === 'running' }} />
        </AgentBlock>
      )}
    </>
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
