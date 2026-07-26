import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as api from '@/shared/api/client'
import type {
  FlightCheckpoint,
  FlightManifest,
  FlightStage,
  FlightStageErrorDetail,
  FlightStageKey,
  FlightStageRemedy,
  FlightStageStatus,
  SpecsCoverageProgress as SpecsCoverageProgressT,
} from '@/shared/api/client'
import { AgentSessionView, type AgentSessionSource } from '@/shared/ui/AgentSessionView'
import { Modal, StatusDot, useEscapeToClose } from '@/shared/ui/atoms'
import { Chip } from '@/shared/ui/StatusChip'
import { DiffView } from '@/shared/ui/DiffView'
import { StepList, StepRow } from '@/shared/ui/StepList'
import { PANEL_CARD_CLASS, PANEL_CARD_STYLE } from '@/shared/ui/PanelCard'
import { DeleteSuiteConfirm } from '@/features/config'
import { useEvaluationExports } from '@/features/evaluation'
import { TestRunPanel, type RunStageEvidence } from './TestRunPanel'
import { FLIGHT_STATUS_TONE, flightStatusLabel } from './FlightsPill'
import { FeatureSetupPanel, FlightDocsPanel, RepoScanPanel, RequirementsFork } from './FlightStagePanels'
import { useInvalidationKey } from '@/shared/state/invalidation'
import type { FeatureActivity } from '../state/feature-activity'
import type { FlightLauncherIntent } from '@/shared/state/nav-state'
import type { ConfigTab } from '@/shared/lib/workspace-view-state'
import { START_FRESH_BLURB, START_FRESH_LABEL } from './FlightStartDialog'
import {
  FactsGrid,
  STAGE_BLURB,
  STAGE_COMPANION,
  STAGE_ICON,
  StageStatusChip,
  checkpointOptionLabel,
  checkpointTitle,
  formatDuration,
  portifyWorkflowId,
  specsCoverageProgress,
  stageFacts,
  stageLabel,
  STAGE_COLUMN,
  stageRailRows,
  stageRowKey,
  stageStateLine,
  stageStatusTone,
  type StageFact,
  type StageRailRow,
} from './stage-meta'
import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'
import {
  buildDerivedManifest,
  derivedEntryStage,
  derivedFlightFeature,
  type DerivedStage,
} from '../lib/derived-stages'

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
const AGENT_STAGE_DIRS: Partial<Record<FlightStageKey, string>> = {
  'scout': 'scout',
  'prd-summary': 'prd-summary',
  'specs-coverage': 'specs-coverage',
}

/** Drill-through targets: each stage view is a LENS onto the real underlying
 *  surface — the actual run detail, coverage ledger, ports config — never a
 *  re-implementation of them (R6). Parallel readiness has no entry here: it
 *  drills through `onOpenConfig` to the Ports tab, so FlightPage never opens
 *  the portify wizard itself. */
export interface FlightDrillThroughs {
  onOpenRun?: (feature: string, runId: string, focusTest?: string) => void
  onOpenCoverage?: (feature: string) => void
}

export function FlightPage({
  flightId,
  onSelectFlight,
  onClose,
  activity,
  derivedStages,
  onStartFlight,
  onOpenConfig,
  onOpenRun,
  onOpenCoverage,
}: {
  /** A real flight id, or a `feature:<name>` derived token (R81). */
  flightId: string
  /** Back to the flights picker (null clears the selected flight). */
  onSelectFlight: (flightId: string | null) => void
  onClose: () => void
  /** Per-feature live activity (runs / portify / authoring) — App owns it. */
  activity?: Map<string, FeatureActivity>
  /** R81: evidence-derived rails per feature — App owns the one instance (same
   *  ownership rule as `activity`). Supplies the stages for a derived token. */
  derivedStages?: Map<string, DerivedStage[]>
  /** Opens the flight launcher for this feature — the "Start fresh" handoff
   *  (R75): full restart with editable intent + repos lives THERE, never in
   *  the re-run dialog. */
  onStartFlight?: (feature: string, intent?: FlightLauncherIntent, fromStage?: FlightStageKey | null) => void
  /** Opens FeatureConfigEditor — the Feature Setup panel's Advanced setup, and
   *  the Parallel-readiness drill-through (which aims at the Ports tab). */
  onOpenConfig?: (feature: string, tab?: ConfigTab) => void
} & FlightDrillThroughs) {
  // The flight detail refetches on `flights-changed`; the setup digest on
  // `features-changed` (repos); the Requirements docs list on `coverage-changed`.
  const refreshKey = useInvalidationKey('flights')
  const configRefreshKey = useInvalidationKey('repos')
  const docsRefreshKey = useInvalidationKey('coverage')
  return (
    <div className="flex h-full w-full flex-col bg-canvas text-primary">
      <FlightDetail flightId={flightId} refreshKey={refreshKey} onClose={onClose} onBackToList={() => onSelectFlight(null)} onNavigateFlight={onSelectFlight} onStartFlight={onStartFlight} onOpenConfig={onOpenConfig} configRefreshKey={configRefreshKey} docsRefreshKey={docsRefreshKey} activity={activity} derivedStages={derivedStages} drill={{ onOpenRun, onOpenCoverage }} />
    </div>
  )
}

function FlightDetail({
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
  const [derivedPrefill, setDerivedPrefill] = useState<{ repoPaths: string[]; env: string } | null>(null)
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
          setDerivedPrefill({ repoPaths: o.prefill.repoPaths, env: o.prefill.env })
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
            return (
              <button
                key={s.key}
                type="button"
                data-testid={`stage-rail-${s.key}`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => setSelectedStage(s.key)}
                title={STAGE_BLURB[s.key]}
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
function stageDrillThrough(
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

/** R73: the one failure card every stage renders when it fails — a danger-toned
 *  twin of CheckpointControls, so a crash reads with the same weight as a
 *  checkpoint instead of a bare red line. Names what failed and shows the raw
 *  detail in a scrollable mono block (these messages run long). Recovery is the
 *  header's state primary (Continue / Repeat a step…), not a second button here
 *  — one Continue, no confusion. Width is capped to line up with the repo-scan
 *  cards above (both on STAGE_COLUMN) so the stage reads as one column, not a full-bleed
 *  banner under narrow cards. */
function StageErrorPanel({ flightId, stageLabel, detail, errorDetail }: {
  flightId: string
  stageLabel: string
  detail: string
  /** Boot-failure evidence (service log tail + path) — rendered under the
   *  verdict so the CAUSE is on the stage, not a log-dig away. */
  errorDetail?: FlightStageErrorDetail
}) {
  const logName = errorDetail?.logPath ? errorDetail.logPath.split('/').pop() : null
  // Machine-actionable fix, derived server-side at read time (live git
  // status) — null when this error has no known remedy. Executing it cleans
  // the repos and resumes the flight; the WS flights-changed refresh then
  // replaces this panel with the retried stage.
  const [remedy, setRemedy] = useState<FlightStageRemedy | null>(null)
  const [remedyBusy, setRemedyBusy] = useState<'stash' | 'commit' | null>(null)
  const [remedyError, setRemedyError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.getFlightRemedy(flightId)
      .then((r) => { if (!cancelled) setRemedy(r.remedy) })
      .catch(() => {}) // no remedy is the quiet default — the raw error stands
    return () => { cancelled = true }
  }, [flightId, detail])
  const runRemedy = (action: 'stash' | 'commit') => {
    setRemedyBusy(action)
    setRemedyError(null)
    api.applyFlightRemedy(flightId, action)
      .catch((err) => {
        setRemedyError(err instanceof Error ? err.message : String(err))
        // Partial failures leave some repos cleaned — re-read so the rows match.
        api.getFlightRemedy(flightId).then((r) => setRemedy(r.remedy)).catch(() => {})
      })
      .finally(() => setRemedyBusy(null))
  }
  return (
    <section
      data-testid="stage-error"
      className={`flex flex-col gap-2.5 rounded-lg border border-danger/45 bg-danger/6 p-3 ${STAGE_COLUMN}`}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-danger">✕</span>
        <span data-testid="stage-error-title" className="text-[12.5px] font-semibold text-danger">
          {stageLabel} failed
        </span>
      </div>
      <p className="text-[12px] text-secondary">
        The step stopped on the error below. Resolve the cause if needed, then Continue from the header to retry.
      </p>
      <pre
        data-testid="stage-error-detail"
        className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded border p-2 text-[10.5px] border-line bg-canvas text-secondary font-mono"
      >
        {detail}
      </pre>
      {errorDetail?.logTail && (
        <>
          <div className="cl-rubric">
            Last lines of {logName ?? 'the service log'}
          </div>
          <pre
            data-testid="stage-error-log-tail"
            className="m-0 max-h-[220px] overflow-auto whitespace-pre rounded border p-2 text-[10.5px] leading-relaxed border-line bg-canvas text-secondary font-mono"
          >
            {errorDetail.logTail}
          </pre>
        </>
      )}
      {errorDetail?.logPath && (
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            data-testid="stage-error-open-log"
            onClick={() => { api.openEditor({ file: errorDetail.logPath }).catch(() => {}) }}
            className="cl-button shrink-0 px-2 py-0.5 text-[11px] text-accent"
          >
            Open full service log
          </button>
          <span className="min-w-0 truncate text-[10px] text-muted font-mono" title={errorDetail.logPath}>
            {errorDetail.logPath}
          </span>
        </div>
      )}
      {remedy && (
        <div data-testid="stage-remedy" className="flex flex-col gap-2 border-t pt-2.5 border-line">
          <div className="cl-rubric">
            Recommended fix
          </div>
          {remedy.repos.length === 0 ? (
            // The error is stale: every repo is clean again (fixed by hand).
            <p className="text-[12px] text-secondary">
              The repos are clean again — Continue from the header retries this step.
            </p>
          ) : (
            <>
              <p className="text-[12px] text-secondary">
                Clean the working trees, then the flight retries this step.
              </p>
              <div className="rounded border border-line">
                {remedy.repos.map((repo, i) => (
                  <div
                    key={repo.path}
                    className={`flex items-center gap-2 px-2.5 py-1.5${i > 0 ? ' border-t' : ''}`}
                    style={i > 0 ? { borderColor: 'var(--border-default)' } : undefined}
                    title={repo.path}
                  >
                    <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                    <span className="text-[11.5px] text-primary font-mono">{repo.name}</span>
                    <span className="ml-auto text-[10px] text-muted font-mono">
                      {repo.modified} modified
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="stage-remedy-stash"
                  disabled={remedyBusy !== null}
                  onClick={() => runRemedy('stash')}
                  className="cl-button-primary px-2.5 py-1 text-xs"
                >
                  {remedyBusy === 'stash' ? 'Stashing…' : 'Stash and continue'}
                </button>
                <button
                  type="button"
                  data-testid="stage-remedy-commit"
                  disabled={remedyBusy !== null}
                  onClick={() => runRemedy('commit')}
                  className="cl-button px-2.5 py-1 text-xs text-accent"
                >
                  {remedyBusy === 'commit' ? 'Committing…' : 'Commit and continue'}
                </button>
              </div>
              <p className="text-[10.5px] text-muted">
                Stash is undoable — <span className="font-mono">git stash pop</span>. Commit uses <span className="font-mono">"canary-lab: wip"</span>.
              </p>
            </>
          )}
          {remedyError && (
            <p data-testid="stage-remedy-error" className="text-[11px] text-danger">{remedyError}</p>
          )}
        </div>
      )}
    </section>
  )
}

/** Which paused-resume narrative this stage carries, if any (null = not a
 *  resume point). Mirrors the two "Continue picks up here" branches in
 *  `stageStateLine` so the card and the state sentence never disagree:
 *   - `interrupted` — pending WITH a startedAt (a pause/restart flipped a
 *     running step back to pending but kept its timestamp);
 *   - `not-started` — the entry step of a paused flight, stopped before it
 *     began (nothing earlier is still ahead of it).
 *  Only ever true for the single stage Continue would enter at, so the card
 *  can't render on the later pending rows that are honestly just waiting. */
function pausedResumeKind(stage: FlightStage, flight: FlightManifest): 'interrupted' | 'not-started' | null {
  if (flight.status !== 'paused' || stage.status !== 'pending') return null
  if (stage.startedAt) return 'interrupted'
  const idx = flight.stages.findIndex((s) => s.key === stage.key)
  const waitingOnEarlier = flight.stages
    .slice(0, idx < 0 ? 0 : idx)
    .some((s) => s.status !== 'done' && s.status !== 'skipped')
  return waitingOnEarlier ? null : 'not-started'
}

/** The paused twin of StageErrorPanel — the "how to pick this back up" card for
 *  a flight parked on a step with nothing else to show (no checkpoint, no
 *  error). Recovery stays the header's one Continue (R74 — "one Continue, no
 *  confusion"), so this card carries NO button; it names where the step stopped,
 *  reassures that finished work is kept, and points the eye up to the header
 *  control the void otherwise left the user hunting for. Quiet neutral card —
 *  a single amber status dot says "waiting on you"; no tinted band or wash
 *  (neutral surfaces, one accent). */
function StagePausedPanel({ kind, compact = false }: {
  kind: 'interrupted' | 'not-started'
  /** R82: the stage already shows its own work below (the Test Run hero keeps
   *  the run on screen through a pause), so there is no void to fill — the same
   *  words render as ONE line instead of a full card that would push the actual
   *  evidence down. Card form is for a stage with nothing else to show. */
  compact?: boolean
}) {
  const interrupted = kind === 'interrupted'
  const heading = interrupted ? 'Paused mid-step' : 'Paused before this step'
  const rest = interrupted
    ? ' to resume this step from where it stopped — everything finished in earlier steps is kept.'
    : ' to start this step — the earlier steps are already done.'
  // An ↑ points at the header control by direction, not by a brittle
  // "top-right" — matches the failed card's "Continue from the header".
  const sentence = (
    <>
      Use <span className="whitespace-nowrap font-semibold text-accent">↑ Continue</span> in the header{rest}
    </>
  )
  if (compact) {
    return (
      <div data-testid="stage-paused" className={`flex items-start gap-2 text-[12px] leading-snug text-secondary ${STAGE_COLUMN}`}>
        <span aria-hidden="true" className="cl-status-dot mt-[5px] shrink-0 bg-warning" style={{ height: '0.45rem', width: '0.45rem' }} />
        <span className="min-w-0">
          <span className="text-primary">{heading}.</span> {sentence}
        </span>
      </div>
    )
  }
  return (
    <section
      data-testid="stage-paused"
      /* Same slab as every other stage card (PanelCard's chrome), so a paused
         step doesn't read as a different kind of object. */
      className={`flex flex-col gap-2 ${PANEL_CARD_CLASS} ${STAGE_COLUMN}`}
      style={PANEL_CARD_STYLE}
    >
      <div className="cl-rubric flex items-center gap-2">
        <span aria-hidden="true" className="cl-status-dot bg-warning" style={{ height: '0.45rem', width: '0.45rem' }} />
        {heading}
      </div>
      <p className="m-0 text-[12px] leading-snug text-primary">{sentence}</p>
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
  const facts = stageFacts(stage, flight, companion ?? undefined)
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
  const evalTaskId = stage.key === 'evaluation-export'
    ? (((stage.evidence as Record<string, unknown> | undefined)?.taskId as string | undefined) ?? flight.links?.evaluationTaskId)
    : undefined
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
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 scrollbar-thin" style={{ scrollbarGutter: 'stable' }}>
      {/* Stable header row: title truncates on the left, the chip + actions
          anchor to the RIGHT edge — switching stages must not shift anything
          horizontally (only the title text itself changes). min-h-6 (=the
          .cl-button height) locks the row height too, so the vertically-centered
          title does NOT drop on stages that carry an action button (Advanced
          setup, drill-through, download) versus the plain chip-only stages. */}
      <div className="flex min-h-6 items-center gap-2">
        <h2 className="min-w-0 truncate text-[13px] font-semibold" title={STAGE_BLURB[stage.key]}>{row.label}</h2>
        <div className="flex-1" />
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
        {stage.key === 'evaluation-export' && <DownloadEvaluationAction flight={flight} stage={stage} />}
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

      {/* Where are we — one plain sentence, always present. */}
      <div data-testid="stage-state-line" className="max-w-[76ch] text-[12px] text-secondary">
        {stageStateLine(stage, flight, companion ?? undefined)}
      </div>

      <FactsGrid facts={facts} />

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
          envFiles={(() => {
            const ev = (stage.evidence ?? {}) as Record<string, unknown>
            return Array.isArray(ev.envFiles) ? (ev.envFiles as unknown[]).filter((f): f is string => typeof f === 'string') : []
          })()}
          onChangeInputs={onStartFlight ? () => onStartFlight(flight.feature, 'fresh') : undefined}
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
          /* Same gate as the header action: only once the config exists on
             disk, so the checkpoint fork stays a two-button decision. */
          onOpenAdvanced={onOpenConfig && (stage.status === 'done' || stage.status === 'skipped')
            ? () => onOpenConfig(flight.feature)
            : undefined}
        />
      )}

      {/* Requirements (R74): while parked on prd-source the FORK owns the
          surface (manual drop zone vs the two agent hints); otherwise the
          read-only docs panel — locked once approved. The folded
          prd-summary's status chips the panel header (R59). The fork is
          gated on the FLIGHT being parked too: a stale checkpoint on a
          paused/aborted record must never render an answerable ask that can
          only 409 (respond requires waiting-for-approval). */}
      {stage.key === 'docs' && stage.status !== 'pending' && (
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
            approved={stage.status === 'done'}
            refreshKey={docsRefreshKey}
            summaryStatus={companion?.status}
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
      {runMerged && runId && (
        <TestRunPanel
          feature={flight.feature}
          runId={runId}
          live={Boolean(runLive) || live}
          evidence={runEvidence}
          onOpenRun={drill.onOpenRun}
          onError={onActionError}
        />
      )}

      {/* Test authoring & coverage (R27): the author↔map loop as a pass
          timeline — coverage % after each mapping feeds the next authoring. */}
      {loopProgress && <SpecsPassTimeline progress={loopProgress} live={live} />}

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
        />
      )}
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

  // `[tag]` or `[tag@<iso>]` — the conductor stamps its own lines; agent output
  // is mirrored untagged, which is what this split is looking for.
  const isTagged = (l: string): boolean => /^\[[\w-]+(?:@[^\]]+)?\]/.test(l)
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
      className={`flex flex-col border-t border-line bg-elevated/22 ${open ? 'min-h-0 flex-1' : 'shrink-0'}`}
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
          <span className="cl-rubric flex items-center gap-1.5">
            {/* The same live pulse the stage's `generating` chip shows — echoed
                on the band so a collapsed rail still advertises that work is
                running inside it. */}
            {live && <StatusDot state="running" className="shrink-0" />}
            Activity
          </span>
          <span className="h-px flex-1 border-t border-dashed border-line" />
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

/** The stages Continue → "from a step…" offers — the user-facing rail rows
 *  (merged-pair primaries), labeled the way the rail labels them. The server
 *  validates prerequisites (checkStageEntry) and 400s an invalid target. */
const REDO_STAGES: Array<{ key: FlightStageKey; label: string }> = [
  { key: 'scout', label: 'Repo scan' },
  { key: 'scaffold', label: 'Suite setup' },
  { key: 'docs', label: 'Requirements' },
  { key: 'specs-coverage', label: 'Test authoring & coverage' },
  { key: 'portify', label: 'Parallel readiness' },
  { key: 'run', label: 'Test Run' },
  { key: 'evaluation-export', label: 'Evaluation Report' },
]

/** R77/R78: the resume target — the rail ROW owning the first unsettled stage,
 *  which is where `resumeFlight` picks up (it flips a failed stage back to
 *  pending and drives from there). Scanning REDO_STAGES directly got this wrong
 *  for pair-merged rows: a failed companion (prd-summary) is not in that list,
 *  so a `done` primary (docs) made the row look finished and the label named the
 *  NEXT row while resume in fact re-entered this one. Scan every stage in
 *  execution order instead, then fold the companion back onto its row. */
function resumeTargetLabel(flight: FlightManifest): string | null {
  const settled = new Set<FlightStageStatus>(['done', 'skipped'])
  const open = FLIGHT_STAGE_KEYS.map((key) => flight.stages.find((s) => s.key === key)).find(
    (stage) => stage != null && !settled.has(stage.status),
  )
  if (!open) return null
  const rowKey = stageRowKey(open.key)
  return REDO_STAGES.find(({ key }) => key === rowKey)?.label ?? null
}

/** R74: ONE Continue control for every settled flight state. Paused → a small
 *  menu (Resume at <stage> / From a step…); everything else goes straight to
 *  the centered re-run dialog. */
function ContinueMenu({
  flight,
  onAction,
  onStartFlight,
}: {
  flight: FlightManifest
  onAction: (call: () => Promise<unknown>, onSuccess?: () => void) => void
  /** The "Start fresh" handoff — opens the launcher with editable inputs. */
  onStartFlight?: (feature: string, intent?: FlightLauncherIntent, fromStage?: FlightStageKey | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const paused = flight.status === 'paused'
  const resumeTarget = resumeTargetLabel(flight)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  // Escape closes the open dropdown first, above the flight page's own
  // Escape-to-exit — one press dismisses the menu, not the whole page.
  useEscapeToClose(() => setOpen(false), open)

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        data-testid="flight-continue"
        aria-haspopup={paused ? 'menu' : 'dialog'}
        aria-expanded={paused ? open : dialogOpen}
        onClick={() => (paused ? setOpen((v) => !v) : setDialogOpen(true))}
        className="cl-button-primary px-2.5 py-1 text-xs"
      >
        Continue ▾
      </button>
      {open && (
        <div
          role="menu"
          className="cl-popover absolute right-0 top-full z-20 mt-1 flex w-[260px] flex-col gap-1 p-1.5"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="flight-resume"
            onClick={() => { setOpen(false); onAction(() => api.resumeFlight(flight.flightId)) }}
            className="cl-hover-row rounded px-2 py-1.5 text-left transition-colors"
          >
            <span className="block text-xs font-medium">
              {resumeTarget ? `▶ Resume at ${resumeTarget}` : '▶ Resume'}
            </span>
            <span className="block text-[10.5px] text-muted">
              Keeps every finished step; retries the first unfinished one
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="flight-redo-open"
            onClick={() => { setOpen(false); setDialogOpen(true) }}
            className="cl-hover-row rounded px-2 py-1.5 text-left transition-colors"
          >
            <span className="block text-xs font-medium">↻ From a step…</span>
            <span className="block text-[10.5px] text-muted">
              Re-run a stage, optionally telling the agent what went wrong
            </span>
          </button>
        </div>
      )}
      {dialogOpen && (
        <RedoFlightDialog
          flight={flight}
          onAction={onAction}
          onClose={() => setDialogOpen(false)}
          onStartFresh={onStartFlight ? () => { setDialogOpen(false); onStartFlight(flight.feature, 'fresh') } : undefined}
        />
      )}
    </div>
  )
}

/** The centered re-run dialog (R74): pick the step to re-enter, see WHY a step
 *  is unavailable (the server's stage-entry validator supplies per-stage
 *  reasons via /api/flights/entry — never a dead 400 on submit), and attach
 *  the optional "what went wrong" note that rides into the agent's prompt. */
function RedoFlightDialog({
  flight,
  onAction,
  onClose,
  onStartFresh,
}: {
  flight: FlightManifest
  onAction: (call: () => Promise<unknown>, onSuccess?: () => void) => void
  onClose: () => void
  /** R75: hands off to the launcher (prefilled, editable inputs) — the one
   *  home for "change what this flight tests"; this dialog never edits them. */
  onStartFresh?: () => void
}) {
  const [entry, setEntry] = useState<Awaited<ReturnType<typeof api.getFlightEntryOptions>> | null>(null)
  const [entryFailed, setEntryFailed] = useState(false)
  const [fromStage, setFromStage] = useState<FlightStageKey | null>(null)
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    let alive = true
    api.getFlightEntryOptions(flight.feature, flight.opts.env)
      .then((options) => { if (alive) setEntry(options) })
      // Validation still happens on submit — a failed pre-check must not
      // brick the dialog, it just can't grey the impossible rows.
      .catch(() => { if (alive) setEntryFailed(true) })
    return () => { alive = false }
  }, [flight.feature, flight.opts.env])

  const entryFor = (key: FlightStageKey): { allowed: boolean; reason?: string } => {
    if (entryFailed) return { allowed: true }
    if (!entry) return { allowed: false, reason: 'checking…' }
    const option = entry.stages.find((s) => s.key === key)
    return option ?? { allowed: true }
  }
  const selectedLabel = REDO_STAGES.find((s) => s.key === fromStage)?.label

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title="Re-run from a step"
      description="Pick where the flight re-enters. Later results are discarded from that step onward; artifacts on disk are kept and reused."
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="cl-button px-3 py-1.5 text-xs">
            Cancel
          </button>
          <button
            type="button"
            data-testid="flight-redo-submit"
            disabled={fromStage === null}
            onClick={() => {
              const stage = fromStage
              if (!stage) return
              onClose()
              onAction(() => api.redoFlight(flight.flightId, {
                fromStage: stage,
                feedback: feedback.trim() || undefined,
              }))
            }}
            className="cl-button-primary px-3 py-1.5 text-xs"
          >
            {selectedLabel ? `Re-run from ${selectedLabel}` : 'Re-run'}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        {/* R76: the full restart LEADS the list — it re-enters before step 1, so
            burying it under seven later steps read as out of order. It stays
            outside the radiogroup and visually secondary (muted, → nav, no
            badge number): correct sequentially, but never the recommended pick —
            it's the rarest and the only one that throws work away. */}
        {onStartFresh && (
          <button
            type="button"
            data-testid="flight-redo-start-fresh"
            onClick={onStartFresh}
            className="cl-hover-row -mb-2 flex items-start gap-3 rounded-md px-3.5 py-2 text-left transition-colors"
          >
            <span
              aria-hidden="true"
              className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] border-line text-muted"
            >
              ✎
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-secondary">
                {START_FRESH_LABEL}
              </span>
              <span className="text-[10.5px] leading-snug text-muted">
                {START_FRESH_BLURB}
              </span>
            </span>
            <span aria-hidden="true" className="shrink-0 self-center text-[12px] text-muted">→</span>
          </button>
        )}

        {/* One connected pipeline the eye reads top-to-bottom. Each row's
            badge carries the LAST record's verdict for that step (✓ done,
            number = never reached); its sub-line says what the step does — or
            the server's full reason when the step can't be an entry point
            (wrapped, never truncated mid-word). */}
        <div
          role="radiogroup"
          aria-label="Step to re-run from"
          className="flex flex-col overflow-hidden rounded-md border border-line"
        >
          {REDO_STAGES.map((s, index) => {
            const { allowed, reason } = entryFor(s.key)
            const selected = fromStage === s.key
            const lastStatus = flight.stages.find((st) => st.key === s.key)?.status
            const settled = lastStatus && lastStatus !== 'pending'
            const badgeTone = selected
              ? 'var(--accent)'
              : settled ? stageStatusTone(lastStatus) : 'var(--text-muted)'
            return (
              <button
                key={s.key}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`flight-redo-${s.key}`}
                disabled={!allowed}
                onClick={() => setFromStage(selected ? null : s.key)}
                /* Neutral surfaces only — rows sit on the modal's own grey;
                   selection = the app's selected-grey + one accent bar. */
                className={[
                  'cl-hover-row flex items-start gap-3 px-3.5 py-2.5 text-left transition-colors border-line',
                  index > 0 ? 'border-t' : '',
                  selected ? 'bg-selected shadow-[inset_2px_0_0_var(--accent)]' : 'bg-transparent',
                  allowed ? 'cursor-pointer' : 'cursor-not-allowed opacity-55',
                ].filter(Boolean).join(' ')}
              >
                <span
                  aria-hidden="true"
                  className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border text-[9.5px] font-semibold"
                  style={{
                    borderColor: `color-mix(in srgb, ${badgeTone} 55%, var(--border-default))`,
                    color: badgeTone,
                    background: 'transparent',
                  }}
                >
                  {settled ? STAGE_ICON[lastStatus] : index + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={`text-[12.5px] font-medium ${allowed ? 'text-primary' : 'text-muted'}`}>
                    {s.label}
                  </span>
                  <span className="text-[10.5px] leading-snug text-muted">
                    {!allowed && reason ? reason : STAGE_BLURB[s.key]}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-secondary">
            What went wrong last time? <span className="font-normal text-muted">(optional — added to the agent's prompt)</span>
          </span>
          <textarea
            data-testid="flight-redo-feedback"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g. the collected docs were about the wrong subsystem"
            rows={2}
            className="cl-input w-full px-2.5 py-2 text-[11.5px]"
          />
        </label>
      </div>
    </Modal>
  )
}

/** R71/W1: the header's ⋯ menu — R74 slimmed it to the destructive disposal
 *  (Delete flight, two-step confirm in place: first click arms, second fires;
 *  closing disarms). Errors route to the header's inline error line. */
function FlightMenu({
  flight,
  onAction,
  onDeleted,
}: {
  flight: FlightManifest
  onAction: (call: () => Promise<unknown>, onSuccess?: () => void) => void
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
  // Escape closes the open ⋯ menu first, above the flight page's own
  // Escape-to-exit — one press dismisses the menu, not the whole page.
  useEscapeToClose(() => setOpen(false), open)

  const active = flight.status === 'running' || flight.status === 'waiting-for-approval'

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
  // R74/R76: Pause is a header button and resume/repeat/start-over collapsed
  // into the header's Continue menu — the ⋯ menu keeps only the destructive
  // disposal, and that disposal is the SUITE (folder + flight history, one
  // deletion concept via the shared type-name confirm). Journal-only
  // deleteFlight left the GUI; it stays as an API capability.
  const [deleteOpen, setDeleteOpen] = useState(false)
  const items: MenuItem[] = [
    ...(!active
      ? [{
          key: 'delete',
          label: 'Delete suite…',
          tone: 'var(--danger)',
          title: 'Delete this suite — its folder (config, tests, envsets, docs) AND its flight history',
          testId: 'flight-delete',
          fire: () => setDeleteOpen(true),
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
          className="cl-popover absolute right-0 top-full z-20 mt-1 flex min-w-[172px] flex-col p-1.5"
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
                className="cl-hover-row rounded px-2.5 py-1.5 text-left text-xs transition-colors"
                style={{ color: item.tone }}
              >
                {isArmed ? item.confirmLabel : item.label}
              </button>
            )
          })}
        </div>
      )}
      <DeleteSuiteConfirm
        feature={flight.feature}
        open={deleteOpen}
        onCancel={() => setDeleteOpen(false)}
        onDeleted={() => { setDeleteOpen(false); onDeleted() }}
      />
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
  derived,
  onSelectStage,
  onToggleAutopilot,
}: {
  flight: FlightManifest
  /** R81: rendering a pseudo-manifest — suppress facts that only a real record
   *  can honestly answer. */
  derived?: boolean
  onSelectStage?: (key: FlightStageKey) => void
  /** R78: autopilot is a preference the user flips whenever they want, not a
   *  start-time-only option — so it reads and toggles from the facts strip. */
  onToggleAutopilot?: (next: boolean) => void
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

  // R79: which CLI conducts this flight's stage agents — read-only (chosen at
  // start, sticky for the record's life), shown as a plain fact so the user
  // always knows without a control they can't change here. R81: a derived
  // flight has no conductor and no stored choice, so naming one would be a
  // fabrication — the agent is picked in the launcher if it's ever conducted.
  if (!derived) items.push({ label: 'Agent', value: flight.opts.agent ?? 'claude' })

  const specs = flight.stages.find((s) => s.key === 'specs-coverage')
  const progress = specsCoverageProgress(specs)
  const lastMapped = progress?.passes.filter((p) => p.note == null).at(-1)
  if (lastMapped) {
    items.push({
      label: 'Coverage',
      value: `${lastMapped.coveragePct}%`,
      tone: lastMapped.gapsOpen === 0 ? 'var(--success)' : 'var(--warning)',
      stage: 'specs-coverage',
    })
  }

  if (flight.runVerdict) {
    items.push({
      label: 'Run',
      value: flight.runVerdict,
      tone: flight.runVerdict === 'passed' ? 'var(--success)' : flight.runVerdict === 'failed' ? 'var(--danger)' : 'var(--text-muted)',
      stage: 'run',
    })
  }

  const docsEv = asRecord(flight.stages.find((s) => s.key === 'docs')?.evidence)
  const docs = Array.isArray(docsEv?.docs) ? docsEv.docs.length : 0
  if (docs > 0) items.push({ label: 'Docs', value: String(docs), stage: 'docs' })

  if (flight.links?.evaluationZip) items.push({ label: 'Report', value: 'ready', tone: 'var(--success)', stage: 'evaluation-export' })

  const autopilotOn = flight.opts.autopilot !== false
  const autopilotActive = autopilotOn && !flight.opts.yolo
  if (items.length === 0 && !onToggleAutopilot) return null
  return (
    <div
      data-testid="flight-summary-strip"
      className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b px-4 py-1.5 border-line"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        {items.map((item) => {
          const body = (
            <>
              <span className="cl-rubric">
                {item.label}
              </span>
              {/* `tone` is a computed status token from stageStatusTone — the
                  one place a colour still arrives as a value, not a class. */}
              <span className="font-mono text-secondary" style={item.tone ? { color: item.tone } : undefined}>{item.value}</span>
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
      {onToggleAutopilot && (
        <div className="ml-auto flex items-center gap-2 border-l border-line pl-3">
          <button
            type="button"
            data-testid="flight-autopilot-toggle"
            aria-pressed={autopilotOn}
            disabled={flight.opts.yolo}
            onClick={() => onToggleAutopilot(!autopilotOn)}
            className="group flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11px] outline-none transition-shadow duration-150 focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] disabled:cursor-default"
            title={flight.opts.yolo
              ? 'This flight runs --yolo: every checkpoint except missing env is skipped regardless of autopilot'
              : autopilotOn
                ? 'Autopilot is answering the checkpoints that have a safe default — click to be asked at every checkpoint from the next one on'
                : 'Every checkpoint parks for you — click to let the safe defaults answer themselves again'}
          >
            <span className="cl-rubric">
              Autopilot
            </span>
            <span
              aria-hidden="true"
              className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-all duration-150 group-hover:brightness-110 group-active:brightness-90 group-disabled:opacity-60 ${autopilotActive ? 'border-accent bg-accent' : 'border-line bg-elevated'}`}
            >
              <span
                className="inline-block h-3 w-3 rounded-full bg-canvas transition-transform duration-150"
                style={{ boxShadow: 'var(--shadow-panel)', transform: autopilotOn ? 'translateX(13px)' : 'translateX(2px)' }}
              />
            </span>
            <span className={`font-mono ${autopilotOn ? 'text-secondary' : 'text-muted'}`}>
              {flight.opts.yolo ? 'yolo' : autopilotOn ? 'on' : 'off'}
            </span>
          </button>
        </div>
      )}
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-line">
      {children}
    </div>
  )
}


function truncate(text: string, max: number): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** What the live pass is doing right now, spelled out under its row. */
function specsPhaseSub(phase: SpecsCoverageProgressT['phase'], gapsOpen: number): string {
  if (phase === 'authoring') return `writing specs to close the ${gapsOpen} open gap${gapsOpen === 1 ? '' : 's'}`
  if (phase === 'validating') return 'validating the authored specs'
  return 'mapping the specs against the requirements'
}

/** The specs↔coverage loop as a pass timeline (R27/R77): settled passes show
 *  what authoring bought (the ledger % after mapping — the number that feeds
 *  the NEXT pass's prompt) with a done ✓; the live pass pulses with its current
 *  half of author↔map; the passes still ahead sit as quiet pending rows so
 *  "3 passes to go" is visible, not inferred. Pending is live-only — a loop that
 *  met target early never spends the rest. Rendered on the shared StepList so it
 *  matches every other stepped stage panel. Data is the adapter's structured
 *  progress, not parsed log. */
function SpecsPassTimeline({ progress, live }: { progress: SpecsCoverageProgressT; live: boolean }) {
  const phaseLabel =
    progress.phase === 'authoring' ? 'authoring tests' : progress.phase === 'validating' ? 'validating specs' : 'mapping coverage'
  if (!live && progress.passes.length === 0) return null
  const pending =
    live && Number.isFinite(progress.maxPasses)
      ? Array.from({ length: Math.max(0, progress.maxPasses - progress.pass) }, (_, i) => progress.pass + 1 + i)
      : []
  return (
    <div data-testid="specs-pass-timeline">
      <h3 className="cl-rubric mb-2">
        Passes
      </h3>
      <StepList>
        {progress.passes.map((p) => (
          <StepRow
            key={p.pass}
            testId={`specs-pass-${p.pass}`}
            state={p.note ? 'warn' : 'done'}
            title={p.note ? `Pass ${p.pass} — ${p.note}` : `Pass ${p.pass} — authored → mapped`}
            sub={
              p.note
                ? 'retried with the errors in the next prompt'
                : `${p.coveragePct}% covered · ${p.gapsOpen} gap${p.gapsOpen === 1 ? '' : 's'} open`
            }
          />
        ))}
        {live && (
          <StepRow
            testId="specs-pass-live"
            state="active"
            title={`Pass ${progress.pass} — ${phaseLabel}…`}
            sub={specsPhaseSub(progress.phase, progress.gapsOpen)}
          />
        )}
        {pending.map((n) => (
          <StepRow key={n} testId={`specs-pass-pending-${n}`} state="pending" title={`Pass ${n} — pending`} />
        ))}
      </StepList>
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
      style={primary ? undefined : { color: failed ? 'var(--danger)' : 'var(--success)' }}
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
  // portify-apply 'revise': the choice needs feedback text, so its button
  // opens this composer instead of responding immediately.
  const [reviseOpen, setReviseOpen] = useState(false)
  const [reviseText, setReviseText] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const respond = (response: { choice?: string; values?: Record<string, string>; data?: unknown; feedback?: string }): void => {
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
      className={`flex flex-col gap-2.5 rounded-lg border border-warning/45 bg-surface p-3 ${STAGE_COLUMN}`}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-warning">⏸</span>
        <span
          data-testid="checkpoint-title"
          className="text-[12.5px] font-semibold"
          title={checkpoint.kind}
        >
          {checkpointTitle(checkpoint.kind)}
        </span>
      </div>
      <p className="text-[12px] text-secondary">{checkpoint.message}</p>

      {checkpoint.kind === 'config-approval' && configError && (
        <p data-testid="checkpoint-config-error" className="text-[11px] text-danger font-mono">
          {configError}
        </p>
      )}

      {/* Same renderer as the Portify wizard's review screen — the checkpoint
          shows the identical captured patch, so it gets the identical
          per-line-coloured diff block, not a plain wall of text. */}
      {diff && <DiffView diff={diff} />}

      {checkpoint.kind === 'missing-env' && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] text-muted">
            Missing: {missing.join(', ')}
          </div>
          <textarea
            data-testid="checkpoint-env-values"
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={'KEY=value\nANOTHER_KEY=value'}
            spellCheck={false}
            rows={4}
            className="cl-input w-full p-2 text-[11px] font-mono"
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
            onClick={() => (option === 'revise' ? setReviseOpen((v) => !v) : respond({ choice: option }))}
            className="cl-button inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"
            title={option}
            style={i === 0
              ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border-default))' }
              : undefined}
          >
            {checkpointOptionLabel(checkpoint.kind, option)}
            {i === 0 && (
              /* R71/W3: the default is named, not color-only. */
              <span
                data-testid="checkpoint-recommended"
                className="cl-badge-accent"
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
            className="cl-button px-2.5 py-1 text-xs text-muted"
          >
            More options ▾
          </button>
        )}
      </div>

      {reviseOpen && (
        <div className="flex flex-col gap-1.5">
          <textarea
            data-testid="checkpoint-revise-feedback"
            value={reviseText}
            onChange={(e) => setReviseText(e.target.value)}
            placeholder="What should the agent change? The edits are re-verified with another double-boot."
            spellCheck={false}
            rows={3}
            className="cl-input w-full p-2 text-[11px] font-mono"
          />
          <button
            type="button"
            data-testid="checkpoint-revise-submit"
            disabled={busy || !reviseText.trim()}
            onClick={() => respond({ choice: 'revise', feedback: reviseText.trim() })}
            className="cl-button self-start px-2.5 py-1 text-xs"
          >
            Send feedback
          </button>
        </div>
      )}

      {failure && <div className="text-[11px] text-danger">{failure}</div>}
    </section>
  )
}
