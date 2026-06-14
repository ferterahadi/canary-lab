import { useEffect, useState } from 'react'
import type { Feature, RunDetail } from '../api/types'
import { useActiveBootSessions, useActiveRuns, useRuns } from '../state/RunsContext'
import { useBenchmarks } from '../state/BenchmarkContext'
import { useActivePortify } from '../state/PortifyContext'
import { isActiveRunStatus } from '../../../../shared/run-state'
import { EvaluationExportTaskStatus } from './EvaluationExportTaskToast'
import { WizardTaskStatus } from './WizardTaskStatus'
import { RunsListDialog } from './RunsListDialog'
import { ServicesDialog } from './ServicesDialog'
import { BenchmarkWindow } from './BenchmarkWindow'
import { McpHealthBadge } from './McpHealthBadge'
import { ConnectionBadge } from './ConnectionBadge'
import { StatusChip } from './StatusChip'
import { ServicesPill } from './ServicesPill'
import { RunsPill } from './RunsPill'
import { PortifyLauncherPill } from './PortifyLauncherPill'
import { PortifyPickerDialog } from './PortifyPickerDialog'
import { BenchmarkPill } from './BenchmarkPill'
import { CleanupPill } from './CleanupPill'

interface Props {
  activeRunDetail: RunDetail | null
  /** Every feature — feeds the always-on Portify launcher's picker. */
  features?: Feature[]
  onNavigateToRun?: (feature: string, runId: string) => void
  onOpenCleanup?: () => void
  /** Start port-ification for a feature (opens the wizard's Plan screen). */
  onStartPortify?: (feature: string) => void
  /** Reopen the in-flight port-ification workflow (by id) in the wizard. */
  onOpenPortify?: (workflowId: string) => void
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
// dialog wiring, and composes presentational pills (ServicesPill, RunsPill,
// PortifyLauncherPill, BenchmarkPill, CleanupPill) and badges (ConnectionBadge,
// McpHealthBadge, StatusChip) that each live in their own file.
export function GlobalStatusBar({ activeRunDetail, features = [], onNavigateToRun, onOpenCleanup, onStartPortify, onOpenPortify }: Props) {
  const { connection } = useRuns()
  const activePortify = useActivePortify()
  const [portifyPickerOpen, setPortifyPickerOpen] = useState(false)
  const { runs: activeRuns } = useActiveRuns()
  const { count: bootCount } = useActiveBootSessions()
  // Boots are NOT runs: the Runs button counts only test/verify runs; boot
  // sessions are surfaced in the separate Services pill.
  const runsCount = activeRuns.filter((r) => r.executionType !== 'boot' && r.executionType !== 'benchmark').length
  const [runsOpen, setRunsOpen] = useState(false)
  const [servicesOpen, setServicesOpen] = useState(false)
  const [benchmarkOpen, setBenchmarkOpen] = useState(false)
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
  // so an active benchmark / run / boot is never hidden behind the chevron.
  const actionsActiveCount =
    (showBenchmark && activeBenchmark ? 1 : 0) + (runsCount > 0 ? 1 : 0) + (bootCount > 0 ? 1 : 0) + (activePortify ? 1 : 0)
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
      <span className="cl-divider shrink-0">·</span>
      <ConnectionBadge state={connection} />
      <span className="cl-divider shrink-0">·</span>
      <McpHealthBadge />
      {services.length > 0 && (
        <>
          <span className="cl-divider shrink-0">·</span>
          <div className="shrink-0">
            <StatusChip
              label={`${services.length} service${services.length > 1 ? 's' : ''}`}
              state={servicesActive ? 'running' : 'idle'}
            />
          </div>
        </>
      )}
      <div className="ml-auto hidden min-w-0 items-center justify-end sm:flex">
        {/* Collapsible action cluster. Defaults to expanded (so the actions
            stay glanceable); the toggle tucks them behind a single control and
            the choice persists. Benchmark sits at the right end, nearest the
            toggle. When collapsed, the toggle carries an aggregate live
            indicator so an active run/boot/benchmark is never hidden. Each pill
            self-guards its own visibility. */}
        <div
          className="flex min-w-0 items-center gap-2 overflow-hidden"
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
          <ServicesPill count={bootCount} onOpen={() => setServicesOpen(true)} />
          <RunsPill count={runsCount} onOpen={() => setRunsOpen(true)} />
          <WizardTaskStatus />
          <EvaluationExportTaskStatus />
          {showBenchmark && <BenchmarkPill active={Boolean(activeBenchmark)} onOpen={() => setBenchmarkOpen(true)} />}
          <PortifyLauncherPill activePortify={activePortify} onOpen={() => setPortifyPickerOpen(true)} />
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
      {runsOpen && (
        <RunsListDialog
          onClose={() => setRunsOpen(false)}
          onNavigateToRun={(feature, runId) => onNavigateToRun?.(feature, runId)}
        />
      )}
      {servicesOpen && <ServicesDialog onClose={() => setServicesOpen(false)} />}
      {benchmarkOpen && <BenchmarkWindow onClose={() => setBenchmarkOpen(false)} />}
      {portifyPickerOpen && (
        <PortifyPickerDialog
          features={features}
          activePortify={activePortify}
          onPick={(feature) => onStartPortify?.(feature)}
          onOpenActive={(workflowId) => onOpenPortify?.(workflowId)}
          onClose={() => setPortifyPickerOpen(false)}
        />
      )}
    </div>
  )
}
