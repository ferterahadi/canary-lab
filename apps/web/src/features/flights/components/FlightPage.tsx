import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../../../shared/api/client'
import type {
  FlightCheckpoint,
  FlightIndexEntry,
  FlightManifest,
  FlightStage,
  FlightStageKey,
} from '../../../shared/api/client'
import { AgentSessionView } from '../../agent-sessions/components/AgentSessionView'
import { StatusDot } from '../../config/components/atoms'
import { FLIGHT_STATUS_TONE, StageMiniRail, flightStatusLabel } from './FlightsPill'

// First Flight detail — the routed full-screen view (?view=flights&flight=<id>)
// that owns a flight's lifecycle: a stage rail on the left (harness-computed
// verdict per stage), the selected stage's detail on the right (checkpoint
// controls when the flight is parked, the stage's agent timeline via
// AgentSessionView where an agent ran, log + evidence otherwise). Without a
// flight id it renders the landing list. Live via `flights-changed` events
// (refreshKey) + a gentle poll while the flight is active.

/** Stage key → the sidecar dir its adapter pins an agent-session ref into.
 *  Stages without an agent (similarity, scaffold, run…) have no entry. */
const AGENT_STAGE_DIRS: Partial<Record<FlightStageKey, string>> = {
  'scout': 'scout',
  'prd-summary': 'prd-summary',
  'specs-coverage': 'specs-coverage',
}

const STAGE_ICON: Record<FlightStage['status'], string> = {
  'pending': '·',
  'running': '▸',
  'waiting-for-approval': '?',
  'done': '✓',
  'failed': '✕',
  'skipped': '↷',
}

function stageTone(status: FlightStage['status']): string {
  if (status === 'done') return 'rgb(52, 211, 153)'
  if (status === 'running') return 'rgb(56, 189, 248)'
  if (status === 'waiting-for-approval') return 'rgb(251, 191, 36)'
  if (status === 'failed') return 'var(--danger)'
  if (status === 'skipped') return 'var(--text-muted)'
  return 'var(--text-muted)'
}

export function FlightPage({
  flightId,
  refreshKey,
  onSelectFlight,
  onClose,
}: {
  flightId: string | null
  refreshKey: number
  onSelectFlight: (flightId: string | null) => void
  onClose: () => void
}) {
  return (
    <div className="flex h-full w-full flex-col" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      {flightId
        ? <FlightDetail flightId={flightId} refreshKey={refreshKey} onClose={onClose} onBackToList={() => onSelectFlight(null)} />
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
        <h1 className="text-sm font-semibold">🕊️ First Flights</h1>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          npx canary-lab fly &lt;repo&gt; "what to test"
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
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                  style={{ color: FLIGHT_STATUS_TONE[f.status], border: `1px solid color-mix(in srgb, ${FLIGHT_STATUS_TONE[f.status]} 35%, transparent)` }}
                >
                  {flightStatusLabel(f.status)}
                </span>
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
}: {
  flightId: string
  refreshKey: number
  onBackToList: () => void
  onClose: () => void
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
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">🕊️ {flight.feature}</h1>
          <div className="truncate text-[10.5px]" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {flight.repoPaths.join(', ')} · "{flight.description}"
          </div>
        </div>
        <span
          data-testid="flight-status"
          className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium"
          style={{ color: tone, border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)` }}
        >
          {flightStatusLabel(flight.status)}
        </span>
        {flight.status === 'running' && <StatusDot state="running" className="shrink-0" />}
        <div className="flex-1" />
        {flight.links?.evaluationZip && (
          <span className="truncate text-[10.5px]" title={flight.links.evaluationZip} style={{ color: 'rgb(52, 211, 153)', fontFamily: 'var(--font-mono)' }}>
            📦 {flight.links.evaluationZip.split('/').pop()}
          </span>
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
          {flight.stages.map((s) => {
            const selected = s.key === stageKey
            const t = stageTone(s.status)
            return (
              <button
                key={s.key}
                type="button"
                data-testid={`stage-rail-${s.key}`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => setSelectedStage(s.key)}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-white/[0.04]"
                style={{ background: selected ? 'var(--bg-selected)' : undefined }}
              >
                <span className="w-3 shrink-0 text-center font-semibold" style={{ color: t }} aria-hidden="true">
                  {STAGE_ICON[s.status]}
                </span>
                <span className="min-w-0 flex-1 truncate" style={{ color: s.status === 'pending' ? 'var(--text-muted)' : undefined }}>
                  {s.key}
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
            <StageDetail flightId={flightId} flight={flight} stage={stage} onResponded={refetch} />
          )}
        </main>
      </div>
    </>
  )
}

function StageDetail({
  flightId,
  flight,
  stage,
  onResponded,
}: {
  flightId: string
  flight: FlightManifest
  stage: FlightStage
  onResponded: () => void
}) {
  const agentDir = AGENT_STAGE_DIRS[stage.key]
  const showAgent = Boolean(agentDir) && stage.status !== 'pending' && stage.status !== 'skipped'
  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-semibold">{stage.key}</h2>
        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ color: stageTone(stage.status), border: `1px solid color-mix(in srgb, ${stageTone(stage.status)} 35%, transparent)` }}>
          {stage.status}
        </span>
        {stage.skipReason && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{stage.skipReason}</span>}
      </div>

      {stage.status === 'failed' && stage.error && (
        <div className="rounded border px-2.5 py-2 text-[11.5px]" style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border-default))', color: 'var(--danger)' }}>
          {stage.error}
        </div>
      )}

      {stage.status === 'waiting-for-approval' && stage.checkpoint && (
        <CheckpointControls flightId={flightId} flight={flight} checkpoint={stage.checkpoint} onResponded={onResponded} />
      )}

      {showAgent && agentDir && (
        <section className="flex min-h-[240px] flex-1 flex-col rounded border" style={{ borderColor: 'var(--border-default)' }}>
          <AgentSessionView source={{ kind: 'flight', flightId, stage: agentDir, live: stage.status === 'running' }} />
        </section>
      )}

      {stage.evidence !== undefined && (
        <section>
          <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Evidence</h3>
          <pre className="overflow-auto rounded border p-2 text-[10.5px]" style={{ borderColor: 'var(--border-default)', fontFamily: 'var(--font-mono)', maxHeight: 220 }}>
            {JSON.stringify(stage.evidence, null, 2)}
          </pre>
        </section>
      )}

      {stage.log && (
        <section>
          <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Log</h3>
          <pre className="overflow-auto whitespace-pre-wrap rounded border p-2 text-[10.5px]" style={{ borderColor: 'var(--border-default)', fontFamily: 'var(--font-mono)', maxHeight: 260 }}>
            {stage.log}
          </pre>
        </section>
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
