import type { ReviewFocus } from '../lib/workspace-view-state'
import { useEffect, useRef, useState } from 'react'
import type { Feature, RunDetail } from '../api/types'
import { BenchmarkPill, BenchmarkWindow, useBenchmarks } from '@/features/benchmark'
import { CleanupPill } from '@/features/cleanup'
import { type FlightsPillProps, FlightsPill, summarizeFlightActivity } from '@/features/flights'
import {
  DirtyReviewDialog,
  ServicesDialog,
  useActiveBootSessions,
  useActiveVerifyRuns,
  useRuns,
} from '@/features/runs'
import { StatusPill } from '../ui/StatusPill'
import { isActiveRunStatus, isUnsettledRunStatus } from '@shared/run-state'
import { TestReviewAcceptedToast } from '@/features/runs/components/TestReviewAcceptedToast'
import { McpHealthBadge } from './McpHealthBadge'
import { ConnectionBadge } from './ConnectionBadge'
import { StatusChip } from '../ui/StatusChip'
import { Tooltip } from '../ui/Tooltip'

interface ReviewControl {
  features?: Feature[]
  onFeaturesChanged?: () => void
  runId?: string | null
  feature?: string | null
  runDetail?: RunDetail | null
  focus?: ReviewFocus
  onFocus?: (focus: ReviewFocus) => void
  onChooseFeature?: (name: string) => void
  /** The routed `?dialog=tests-review` state. When absent, local state applies. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

interface Props {
  activeRunDetail: RunDetail | null
  notificationControl?: React.ReactNode
  onRunLatestTests?: (feature: string) => void
  runStartPending?: boolean
  onOpenCleanup?: () => void
  /** App owns the live flight data and routed picker actions. */
  flightPill?: FlightsPillProps
  review?: ReviewControl
  gettingStarted?: { available: boolean; unseen: boolean; onOpen: () => void }
  returnToFlight?: { flightId: string; label?: string | null; onOpen: (flightId: string) => void } | null
  /** Open a feature's Flight directly at Parallel setup. */
  onOpenPortify?: (feature: string) => void
  /** Open a run's detail (the Deploy-check pill's click-through) — App routes it. */
  onNavigateToRun?: (feature: string, runId: string) => void
}

const EMPTY_FLIGHT_PILL: FlightsPillProps = { flights: [], onOpenFlight: () => {} }

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
export function GlobalStatusBar({
  notificationControl,
  review,
  activeRunDetail,
  onRunLatestTests,
  runStartPending = false,
  onOpenCleanup,
  flightPill = EMPTY_FLIGHT_PILL,
  gettingStarted,
  onOpenPortify,
  onNavigateToRun,
  returnToFlight,
}: Props) {
  const { connection, runs } = useRuns()
  const [acceptedReview, setAcceptedReview] = useState<{ feature: string; revision: string; detail?: RunDetail | null } | null>(null)
  const runInProgress = runStartPending || isUnsettledRunStatus(activeRunDetail?.manifest.status)
    || runs.some((run) => isUnsettledRunStatus(run.status))
  const runInProgressRef = useRef(runInProgress)
  runInProgressRef.current = runInProgress
  useEffect(() => { if (runInProgress) setAcceptedReview(null) }, [runInProgress])
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
  const [localSpecReviewOpen, setLocalSpecReviewOpen] = useState(false)
  const reviewOpen = review?.open ?? localSpecReviewOpen
  const setReviewOpen = (open: boolean): void => {
    setLocalSpecReviewOpen(open)
    review?.onOpenChange?.(open)
  }
  // A baseline toggle must not remove the linked suite from the review rail.
  const pendingRuns = runs.filter((r) => (isActiveRunStatus(r.status) && (r.pendingSpecEdits ?? 0) > 0) || r.runId === review?.runId)
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
  const activeFlightCount = summarizeFlightActivity(flightPill.flights, flightPill.preFlights ?? [], flightPill.activity ?? new Map()).activeCount
  const actionsActiveCount =
    (showBenchmark && activeBenchmark ? 1 : 0) + (activeFlightCount > 0 ? 1 : 0)
  const status = activeRunDetail?.manifest.status

  // Guard: only treat 'running' and 'healing' as truly active. The runs
  // index can become stale if the orchestrator crashes, so double-check the
  // manifest status from the detail endpoint.
  const isActive = isActiveRunStatus(status)
  const services = activeRunDetail?.manifest.services ?? []
  const servicesActive = isActive
  const returnFlightTooltip = returnToFlight?.label
    ? `Go back to the “${returnToFlight.label}” flight.`
    : 'Go back to the flight you came from.'

  return (
    <div className="relative">
      <div
        className="cl-shell-bar flex items-center gap-3 px-4 py-2 overflow-hidden"
      >
      {/* Keep the drill-through exit before the wordmark, separate from status
          indicators and outside the collapsible action cluster. */}
      {returnToFlight && (
        <div className="shrink-0 border-r pr-3" style={{ borderColor: 'var(--border-default)' }}>
          <Tooltip label={returnFlightTooltip}>
            <button
              type="button"
              data-testid="return-to-flight"
              onClick={() => returnToFlight.onOpen(returnToFlight.flightId)}
              className="cl-icon-button h-7 w-7"
              aria-label={returnFlightTooltip}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
          </Tooltip>
        </div>
      )}
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
      <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
        {/* The inbox stays visible when the optional action cluster collapses. */}
        <div className="shrink-0" data-testid="status-bar-notifications">{notificationControl}</div>
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
          className="hidden min-w-0 items-center gap-2 overflow-hidden py-1.5 -my-1.5 sm:flex"
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
              the run detail's Create evaluation report action; wizard drafts resume
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
          <FlightsPill {...flightPill} />
          {/* Onboarding's permanent home. It remains useful after the samples
              are deleted because the external-agent side teaches every skill. */}
          {gettingStarted?.available && (
            <StatusPill
              dotState="idle"
              name="Getting started"
              overlayDot={gettingStarted.unseen}
              onClick={gettingStarted.onOpen}
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
      {reviewOpen && (
        <DirtyReviewDialog
          onFeaturesChanged={review?.onFeaturesChanged}
          onChooseFeature={review?.onChooseFeature}
          focus={review?.focus}
          onFocus={review?.onFocus}
          focusFeature={review?.feature}
          focusRunId={review?.runId}
          focusRunDetail={review?.runDetail}
          features={review?.features ?? []}
          pendingRuns={pendingRuns}
          onClose={() => setReviewOpen(false)}
          onAccepted={(feature, receipt, detail) => {
            if (receipt.decision === 'accepted' && receipt.execution.status === 'new-run-required' && !runInProgressRef.current) {
              setAcceptedReview({ feature, revision: receipt.review_revision, detail })
            }
          }}
        />
      )}
      {acceptedReview && !runInProgress && <TestReviewAcceptedToast key={`${acceptedReview.feature}:${acceptedReview.revision}`} {...acceptedReview} onDismiss={() => setAcceptedReview(null)} onRun={onRunLatestTests} />}
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
