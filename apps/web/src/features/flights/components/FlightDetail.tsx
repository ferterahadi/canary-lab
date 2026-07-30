import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/shared/api/client'
import type { FlightEntryOptions, FlightManifest, FlightStage, FlightStageKey } from '@/shared/api/client'
import { StatusDot, useEscapeToClose } from '@/shared/ui/atoms'
import { Chip } from '@/shared/ui/StatusChip'
import { FLIGHT_STATUS_TONE, flightStatusLabel } from './FlightsPill'
import type { FeatureActivity } from '../state/feature-activity'
import type { FlightLauncherIntent } from '@/shared/state/nav-state'
import type { ConfigTab } from '@/shared/lib/workspace-view-state'
import { STAGE_BLURB, STAGE_COMPANION, STAGE_ICON, formatDuration, stageLabel, stageRailRows, stageStatusTone } from './stage-meta'
import { stageStateLine } from './StageStatusLines'
import {
  buildDerivedManifest,
  derivedEntryStage,
  derivedFlightFeature,
  type DerivedStage,
} from '../lib/derived-stages'
import { DownloadEvaluationAction } from './CheckpointControls'
import { ContinueMenu, FlightMenu } from './FlightControls'
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
  onBackToList,
  onNavigateFlight,
  onClose,
  onStartFlight,
  onOpenConfig,
  configRefreshKey,
  docsRefreshKey,
  activity,
  derivedStages,
  drill,
}: {
  flightId: string
  refreshKey: number
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
  derivedStages?: Map<string, DerivedStage[]>
  drill: FlightDrillThroughs
}) {
  // R81 — derived mode: `flightId` is a `feature:<name>` token, so there is no
  // record to GET. The rail comes from live workspace evidence and everything
  // below renders from a client-only pseudo-manifest, unchanged.
  const derivedFeature = derivedFlightFeature(flightId)
  const derivedRail = derivedFeature ? derivedStages?.get(derivedFeature) : undefined
  const [derivedPrefill, setDerivedPrefill] = useState<{ repoPaths: string[]; env: string; evidence?: FlightEntryOptions['evidence'] } | null>(null)
  const [fetched, setFlight] = useState<FlightManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedStage, setSelectedStage] = useState<FlightStageKey | null>(null)
  // R71/W1: one inline error line under the header — every header/run control
  // failure lands here instead of a silent `.catch(() => {})`.
  const [actionError, setActionError] = useState<string | null>(null)

  const refetch = useCallback((): void => {
    if (derivedFeature) {
      // No record to load. One entry call supplies the repo/env prefill the
      // panels show — and answers "has a record appeared since?", which is how
      // the token self-heals: the moment a flight is minted for this feature
      // (conducted from here, or from anywhere else), we hand over to it so the
      // URL can never point at a stale derived view.
      api.getFlightEntryOptions(derivedFeature)
        .then((o) => {
          setError(null)
          setDerivedPrefill({ repoPaths: o.prefill.repoPaths, env: o.prefill.env, evidence: o.evidence })
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
  const flight = derivedManifest ?? (derivedFeature ? null : fetched)
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
  // first failed → the row that resumes next → last done. The user's explicit
  // pick wins. (R78: a paused flight whose current row is half-finished has no
  // `done` row after it, so without the pending fallback the panel would open
  // on "Pick a stage." instead of the step the user just paused.)
  const autoStage = useMemo((): FlightStageKey | null => {
    const pick =
      railRows.find((s) => s.status === 'waiting-for-approval')
      ?? railRows.find((s) => s.status === 'running')
      ?? railRows.find((s) => s.status === 'failed')
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

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-xs text-muted">
        <div>Flight {flightId} could not be loaded: {error}</div>
        <button type="button" onClick={onBackToList} className="cl-button px-2.5 py-1 text-xs">All flights</button>
      </div>
    )
  }
  if (!flight) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted">Loading flight…</div>
  }

  const tone = FLIGHT_STATUS_TONE[flight.status]
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
            title={derivedFeature
              ? (flight.status === 'done'
                ? 'Every step complete — done outside the conductor, so there is no flight record'
                : 'Steps completed outside the conductor — continue to conduct the rest')
              : flight.status === 'paused'
              ? (flight.pauseReason === 'user' ? 'Paused by you — Continue resumes it'
                : flight.pauseReason === 'restart' ? 'Interrupted by a server restart — Continue resumes it'
                : 'A stage failed — Continue retries it')
              : undefined}
            icon={flight.status === 'running' ? <StatusDot state="running" className="shrink-0" /> : undefined}
            label={derivedFeature && flight.status !== 'done' ? 'idle' : flightStatusLabel(flight.status)}
          />
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
        {/* R74: one button per state. Active → Pause (immediate + honest —
            agent killed, run aborted, repo freed; every stage re-runs cleanly).
            Settled → ONE Continue menu absorbing resume / repeat-a-step /
            start-over: "Resume at <stage>" (paused) + "From a step…" (+ optional
            what-went-wrong note that reaches the agent's prompt). */}
        {(flight.status === 'running' || flight.status === 'waiting-for-approval') && (
          <button
            type="button"
            data-testid="flight-pause"
            onClick={() => act(() => api.pauseFlight(flightId))}
            className="cl-button px-2.5 py-1 text-xs"
            title="Stops the running agent and test run immediately; Continue re-runs the interrupted step"
          >
            ⏸ Pause
          </button>
        )}
        {/* R81 — a derived flight has no record, so every record-scoped control
            (resume / redo / abort / delete / download) would call an id that
            doesn't exist. It gets exactly one primary instead: conduct the rest
            from the first step without evidence, or — with every step already
            done — fly it again from the top. Both hand off to the launcher,
            which mints the record. */}
        {derivedFeature ? (
          <button
            type="button"
            data-testid="derived-conduct"
            onClick={() => onStartFlight?.(derivedFeature, derivedEntry ? 'refly' : 'fresh', derivedEntry)}
            className="cl-button-primary px-2.5 py-1 text-xs"
            title={derivedEntry
              ? `Conduct this suite from ${stageLabel(derivedEntry)} — the steps already done are kept`
              : 'Every step is done — start a fresh flight to fly it again'}
          >
            {derivedEntry ? `Continue from ${stageLabel(derivedEntry)}` : 'Fly again'}
          </button>
        ) : (
          <>
            {flight.status === 'done' && evalStage && (
              <DownloadEvaluationAction flight={flight} stage={evalStage} testId="flight-primary-download" primary />
            )}
            {(flight.status === 'paused' || flight.status === 'failed' || flight.status === 'aborted' || flight.status === 'done') && (
              <ContinueMenu flight={flight} onAction={act} onStartFlight={onStartFlight} />
            )}
            <FlightMenu flight={flight} onAction={act} onDeleted={onBackToList} />
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
          <button type="button" onClick={() => setActionError(null)} className="cl-button shrink-0 px-2 py-0.5 text-[10.5px]">Dismiss</button>
        </div>
      )}

      <FlightSummaryStrip
        flight={flight}
        derived={derivedFeature != null}
        onSelectStage={setSelectedStage}
        // R81: no record → nothing to toggle. Autopilot is chosen in the
        // launcher when this suite is actually conducted.
        onToggleAutopilot={derivedFeature ? undefined : (next) => act(() => api.setFlightAutopilot(flight.flightId, next))}
      />

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Flight stages"
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
          <div className="flex h-6 items-center justify-between px-2">
            <span className="cl-rubric leading-none">
              Stages
            </span>
            <button
              type="button"
              data-testid={selectedStage === null ? 'rail-following' : 'rail-resume-follow'}
              aria-pressed={selectedStage === null}
              onClick={() => setSelectedStage(null)}
              className="cl-button flex items-center gap-1 px-1.5 py-0.5 text-[10px] leading-none"
              style={selectedStage === null
                ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border-default))', background: 'var(--bg-selected)' }
                : undefined}
              title={selectedStage === null
                ? 'Selection follows the stage that needs eyes'
                : 'Return to auto-selecting the stage that needs eyes'}
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
            // A merged row's wall-clock spans its primary + folded companion
            // (run→heal, scaffold→env-capture, docs→prd-summary) — R61.
            const primary = flight.stages.find((st) => st.key === s.key)
            const folded = flight.stages.find((st) => st.key === STAGE_COMPANION[s.key])
            const duration = formatDuration(primary?.startedAt, folded?.endedAt ?? primary?.endedAt)
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
            <div className="text-xs text-muted">Pick a stage.</div>
          ) : (
            <StageDetail key={stage.key} flightId={flightId} flight={flight} row={row} stage={stage} companion={companionStage} runLive={runLive} onResponded={refetch} onActionError={setActionError} onStartFlight={onStartFlight} onOpenConfig={onOpenConfig} configRefreshKey={configRefreshKey} docsRefreshKey={docsRefreshKey} drill={drill} />
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
    return { label: 'Open coverage ledger →', onClick: () => open(flight.feature) }
  }
  if (stage.key === 'specs-coverage' && drill.onOpenCoverage && stage.status !== 'pending') {
    const open = drill.onOpenCoverage
    return { label: 'Open coverage ledger →', onClick: () => open(flight.feature) }
  }
  // Parallel readiness drills to the feature's Ports tab — the resting surface
  // that OWNS injectability: the saved overlay (diff + double-boot proof), the
  // per-service patch paths, the slot ↔ env-var map, and the remove control.
  // Not the portify wizard: FlightPage doesn't open it any more. A workflow
  // still mid-flight is reachable from that tab's own Review & save / View
  // progress button, so nothing is stranded — and the wizard stays one
  // surface's business instead of two.
  // Unlocks once the stage has been touched at all — settled, skipped, or
  // parked. `pending` alone isn't "never ran": an interrupted stage reverts to
  // pending and keeps its startedAt, and that's exactly when you want the tab.
  if (stage.key === 'portify' && onOpenConfig && (stage.status !== 'pending' || stage.startedAt != null)) {
    return { label: 'Open ports config →', onClick: () => onOpenConfig(flight.feature, 'ports') }
  }
  return null
}
