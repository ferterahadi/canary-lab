import { useEffect, useState } from 'react'
import type { Feature, RunDetail } from '../api/types'
import { BenchmarkPill, BenchmarkWindow, useBenchmarks } from '@/features/benchmark'
import { CleanupPill } from '@/features/cleanup'
import { type DerivedStage, type FeatureActivity, FlightsPill } from '@/features/flights'
import {
  DirtyReviewDialog,
  DirtyTestsPill,
  ServicesDialog,
  useActiveBootSessions,
  useActiveVerifyRuns,
  useRuns,
} from '@/features/runs'
import { StatusPill } from '../ui/StatusPill'
import { isActiveRunStatus } from '@shared/run-state'
import { McpHealthBadge } from './McpHealthBadge'
import { ConnectionBadge } from './ConnectionBadge'
import { StatusChip } from '../ui/StatusChip'
import type { FlightIndexEntry, PlanFeaturesTask } from '../api/client'

interface Props {
  activeRunDetail: RunDetail | null
  /** Every feature — feeds the dirty-tests review panel. */
  features?: Feature[]
  onOpenCleanup?: () => void
  /** Flight index (App owns it, WS-driven) — feeds the Flights pill. */
  flights?: FlightIndexEntry[]
  /** Pre-flight (plan-features) tasks in progress / awaiting review — the
   *  pill's pre-flight rows (App owns it, `pre-flight-changed`-driven). */
  preFlights?: PlanFeaturesTask[]
  /** Reopen the new-flight dialog attached to a running/awaiting pre-flight. */
  onOpenPreFlight?: (taskId: string) => void
  /** Per-feature live activity (runs / portify / authoring) — App owns the
   *  one useFeatureActivity instance; the pill stays presentational. */
  activity?: Map<string, FeatureActivity>
  /** Per-feature evidence-derived stage rails for flightless picker rows —
   *  App owns the one useDerivedFeatureStages instance (same ownership rule
   *  as `activity`). */
  derivedStages?: Map<string, DerivedStage[]>
  /** Whether to offer Getting Started — driven by the workspace visibility setting. */
  demoAvailable?: boolean
  /** Attention dot on that pill: the chooser has never been opened. */
  demoUnseen?: boolean
  onOpenDemo?: () => void
  /** Open the routed flight detail view (null = the flights picker). */
  onOpenFlight?: (flightId: string | null) => void
  /** Picker open-state, driven off the route (`view=flights` + no flight) so it's
   *  the same deep-linkable surface the URL addresses — see cl_route-every-surface. */
  flightsPickerOpen?: boolean
  onFlightsPickerOpenChange?: (open: boolean) => void
  /** Open the real surface behind an activity-only pill row (run detail /
   *  portify workflow / wizard draft) — App routes it. */
  onOpenActivity?: (feature: string, activity: FeatureActivity) => void
  /** Open the flight launcher for a never-flown picker row (R49). */
  onStartFlight?: (feature: string) => void
  /** Open a feature's Flight directly at Parallel setup. */
  onOpenPortify?: (feature: string) => void
  /** Open a run's detail (the Deploy-check pill's click-through) — App routes it. */
  onNavigateToRun?: (feature: string, runId: string) => void
  /** R83: the flight a stage drill-through left, or null. A flight's drill-through
   *  swaps the whole view (the run detail is a workspace column, with no close of
   *  its own), so without a way back the trip is one-way. Lives outside the
   *  collapsible action cluster deliberately — collapsing the actions must not
   *  hide the only exit. */
  returnFlight?: string | null
  /** Label for that chip — the flight's feature name. */
  returnFlightLabel?: string | null
  onReturnToFlight?: (flightId: string) => void
}

// Always-visible top bar showing whether any run is currently active across
// all features. Single source of truth for "is something running right now?"
// — used to gate the Run Now button so we don't spawn concurrent runs that
// would saturate local resources.
//
// Also surfaces the WebSocket connection state ("connecting" / "live" /
// "reconnecting" / "disconnected"). Push frames keep run state in sync;
// when the channel drops, the user sees a banner so they know the data
// they're looking at may be stale until the socket reconnects.
//
// This component is the orchestrator: it owns the cross-feature state and
// dialog wiring, and composes presentational pills (FlightsPill,
// BenchmarkPill, CleanupPill) and badges (ConnectionBadge, McpHealthBadge,
// StatusChip) that each live in their own file. Since the R6 consolidation the
// Flight pill is the single per-feature entry point — coverage, portify, and
// run surfaces are reached through a flight's per-stage drill-throughs (or the
// features column / config editor).
export function GlobalStatusBar({ activeRunDetail, features = [], onOpenCleanup, flights = [], preFlights = [], onOpenPreFlight, activity = new Map(), derivedStages = new Map(), demoAvailable = false, demoUnseen = false, onOpenDemo, onOpenFlight, flightsPickerOpen, onFlightsPickerOpenChange, onOpenActivity, onStartFlight, onOpenPortify, onNavigateToRun, returnFlight = null, returnFlightLabel = null, onReturnToFlight }: Props) {
  const { connection } = useRuns()
  const { count: bootCount } = useActiveBootSessions()
  // Deployed-env verification runs (record-only) get their own pill (R27) —
  // a verify is neither a test run nor a boot, so neither the Flights pill
  // nor Services should have to explain it.
  const { runs: verifyRuns } = useActiveVerifyRuns()
  // Boots are NOT runs: held boot sessions surface as a chip that opens the
  // Services dialog; test/verify runs light the Flights pill (R26 — the pill
  // consolidation absorbed the old Runs pill; per-feature activity rows are
  // the way into a live run now).
  const [servicesOpen, setServicesOpen] = useState(false)
  const [benchmarkOpen, setBenchmarkOpen] = useState(false)
  const [dirtyReviewOpen, setDirtyReviewOpen] = useState(false)
  // Features with modified test files — drives the danger pill + review panel.
  const dirtyFeatureCount = features.filter((f) => f.dirty?.status === 'dirty').length
  // The right-hand action cluster collapses into a single toggle. Default
  // expanded (actions stay glanceable); the choice persists across reloads.
  const [actionsExpanded, setActionsExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cl-actions-expanded') !== 'false'
    } catch {
      return true
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('cl-actions-expanded', String(actionsExpanded))
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [actionsExpanded])
  const { benchmarks } = useBenchmarks()
  const activeBenchmark = benchmarks.find((b) => b.status === 'sabotaging' || b.status === 'running')
  // Benchmark is an internal-experiment surface (product surface retired in
  // 1.0.0) — hidden unless explicitly requested via ?showBenchmark=true.
  const showBenchmark = new URLSearchParams(window.location.search).get('showBenchmark') === 'true'
  // Aggregate "something's happening" count shown on the toggle when collapsed,
  // so an active benchmark / flight / run / portify / authoring job is never
  // hidden behind the chevron. Mirrors the Flights pill's own attention set.
  const activeFlightCount = new Set([
    ...flights.filter((f) => f.status === 'running' || f.status === 'waiting-for-approval').map((f) => f.feature),
    ...activity.keys(),
  ]).size
    // Pre-flights in progress / awaiting review count as active too, so a
    // backgrounded plan isn't hidden behind the collapsed-actions chevron.
    + preFlights.filter((t) => t.status === 'running' || t.status === 'done').length
  const actionsActiveCount =
    (showBenchmark && activeBenchmark ? 1 : 0) + (activeFlightCount > 0 ? 1 : 0)
  const status = activeRunDetail?.manifest.status

  // Guard: only treat 'running' and 'healing' as truly active. The runs
  // index can become stale if the orchestrator crashes, so double-check the
  // manifest status from the detail endpoint.
  const isActive = isActiveRunStatus(status)
  const services = activeRunDetail?.manifest.services ?? []
  const servicesActive = isActive

  return (
    <div className="relative">
      <div
        className="cl-shell-bar flex items-center gap-3 px-4 py-2 overflow-hidden"
      >
      <span className="shrink-0 inline-flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
          style={{
            background: 'var(--accent)',
            boxShadow: '0 0 12px color-mix(in srgb, var(--accent) 60%, transparent)',
          }}
        />
        <span className="cl-wordmark">Canary Lab</span>
      </span>
      <ConnectionBadge state={connection} />
      <McpHealthBadge />
      {services.length > 0 && (
        <div className="shrink-0">
          <StatusChip
            label={`${services.length} service${services.length > 1 ? 's' : ''}`}
            state={servicesActive ? 'running' : 'idle'}
          />
        </div>
      )}
      {/* R83: the way back to the flight a stage drill-through left. Only the
          run detail actually needs it (it's a workspace column, so it has no
          close of its own — the coverage ledger fixes its own Close instead),
          but it renders on any non-flight view for one consistent exit. Same
          `cl-button` the flight header's "All flights" uses — a nav action, not
          a status. */}
      {returnFlight && onReturnToFlight && (
        <button
            type="button"
            data-testid="return-to-flight"
            onClick={() => onReturnToFlight(returnFlight)}
            className="cl-button shrink-0 max-w-[220px] truncate px-2.5 py-1 text-xs"
            title={`Back to the ${returnFlightLabel ?? 'flight'} flight you came from`}
          >
          ← {returnFlightLabel ?? 'Flight'}
        </button>
      )}
      {dirtyFeatureCount > 0 && (
        <div className="shrink-0">
          <DirtyTestsPill count={dirtyFeatureCount} onOpen={() => setDirtyReviewOpen(true)} />
        </div>
      )}
      <div className="ml-auto hidden min-w-0 items-center justify-end sm:flex">
        {/* Collapsible action cluster. Defaults to expanded (so the actions
            stay glanceable); the toggle tucks them behind a single control and
            the choice persists. Benchmark sits at the right end, nearest the
            toggle. When collapsed, the toggle carries an aggregate live
            indicator so an active run/boot/benchmark is never hidden. Each pill
            self-guards its own visibility. */}
        <div
          // py/-my pair: the cluster stays overflow-hidden for the collapse
          // animation, but reserves vertical room so a pill's top-right overlay
          // attention dot (StatusPill overlayDot, pinned at -top-1) isn't clipped
          // by that same overflow. The negative margin cancels the layout effect.
          className="flex min-w-0 items-center gap-2 overflow-hidden py-1.5 -my-1.5"
          aria-hidden={!actionsExpanded}
          style={{
            maxWidth: actionsExpanded ? 800 : 0,
            opacity: actionsExpanded ? 1 : 0,
            transform: actionsExpanded ? 'none' : 'translateX(10px)',
            marginRight: actionsExpanded ? 8 : 0,
            pointerEvents: actionsExpanded ? 'auto' : 'none',
            transition:
              'max-width 300ms cubic-bezier(0.22,1,0.36,1), opacity 200ms ease, transform 260ms cubic-bezier(0.22,1,0.36,1), margin-right 300ms cubic-bezier(0.22,1,0.36,1)',
          }}
        >
          {/* R6 consolidation: the Flight pill is the single per-feature entry
              point — Coverage/Portify/Services pills are absorbed into the
              flight detail's per-stage drill-throughs (coverage ledger, portify
              workflow, run detail). R15/R19: the Exports and Wizards pills are
              gone too — exports live on the flight's Export results stage and
              the run detail's Review Evaluation action; wizard drafts resume
              through the routed add-test dialog (openTask re-attaches to the
              latest draft). R26: the Runs pill is absorbed as well — a live
              run (or portify / authoring job) lights the Flights pill and its
              per-feature rows say what's happening. Cleanup stays: it's
              workspace-level. */}
          {showBenchmark && <BenchmarkPill active={Boolean(activeBenchmark)} onOpen={() => setBenchmarkOpen(true)} />}
          {/* R27: held boot sessions, renamed + moved into the action cluster —
              "Services" is the domain word for the health-checked processes
              the boot holds up. Visible only while something is up. */}
          {bootCount > 0 && (
            <StatusPill
              dotState="running"
              name="Services"
              detail={`${bootCount} up`}
              count={bootCount > 1 ? bootCount : undefined}
              countTone="boot"
              onClick={() => setServicesOpen(true)}
              title={`${bootCount} booted service session${bootCount > 1 ? 's' : ''} held up for manual testing — open to inspect or stop`}
              ariaLabel={`Show booted services (${bootCount} up)`}
            />
          )}
          {/* R27: deployed-env verification (record-only run against a live
              environment) — "Deploy check" says the outcome, not the internals.
              Click lands on the verification run's detail. */}
          {verifyRuns.length > 0 && (
            <StatusPill
              dotState="running"
              name="Deploy check"
              detail={verifyRuns[0].verificationConfigName ?? verifyRuns[0].feature}
              count={verifyRuns.length > 1 ? verifyRuns.length : undefined}
              onClick={() => onNavigateToRun?.(verifyRuns[0].feature, verifyRuns[0].runId)}
              title={`Verifying the deployed environment (record-only): ${verifyRuns.map((r) => r.feature).join(', ')}`}
              ariaLabel={`Open deploy check (${verifyRuns.length} active)`}
            />
          )}
          <FlightsPill
            flights={flights}
            preFlights={preFlights}
            activity={activity}
            features={features.map((f) => ({ name: f.name, group: f.group, stages: derivedStages.get(f.name) }))}
            open={flightsPickerOpen}
            onOpenChange={onFlightsPickerOpenChange}
            onStartFlight={(feature) => onStartFlight?.(feature)}
            onOpenFlight={(flightId) => onOpenFlight?.(flightId)}
            onOpenActivity={(feature, act) => onOpenActivity?.(feature, act)}
            onOpenPreFlight={(taskId) => onOpenPreFlight?.(taskId)}
          />
          {/* Onboarding's permanent home. It remains useful after the samples
              are deleted because the external-agent side teaches every skill. */}
          {demoAvailable && (
            <StatusPill
              dotState="idle"
              name="Getting started"
              overlayDot={demoUnseen}
              onClick={() => onOpenDemo?.()}
              title="Choose a workflow for an external or internal agent"
              ariaLabel="Open Getting Started"
            />
          )}
          <CleanupPill onOpen={() => onOpenCleanup?.()} />
        </div>
        <button
          type="button"
          onClick={() => setActionsExpanded((v) => !v)}
          className="cl-button flex shrink-0 items-center gap-1.5 px-2 py-1"
          aria-expanded={actionsExpanded}
          aria-label={actionsExpanded ? 'Collapse actions' : 'Expand actions'}
          title={
            actionsExpanded
              ? 'Collapse actions'
              : actionsActiveCount > 0
                ? `${actionsActiveCount} active — expand actions`
                : 'Expand actions'
          }
          style={
            !actionsExpanded && actionsActiveCount > 0
              ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border-default))' }
              : undefined
          }
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              fontSize: 14,
              lineHeight: 1,
              transition: 'transform 260ms cubic-bezier(0.22,1,0.36,1)',
              transform: actionsExpanded ? 'rotate(0deg)' : 'rotate(180deg)',
            }}
          >
            ›
          </span>
          {!actionsExpanded && actionsActiveCount > 0 && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--accent)' }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)' }}>{actionsActiveCount}</span>
            </span>
          )}
        </button>
      </div>
      </div>
      {servicesOpen && <ServicesDialog onClose={() => setServicesOpen(false)} />}
      {dirtyReviewOpen && <DirtyReviewDialog features={features} onClose={() => setDirtyReviewOpen(false)} />}
      {benchmarkOpen && (
        <BenchmarkWindow
          onClose={() => setBenchmarkOpen(false)}
          onOpenPortify={(feature) => {
            setBenchmarkOpen(false)
            onOpenPortify?.(feature)
          }}
        />
      )}
    </div>
  )
}
