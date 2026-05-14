import type { RunDetail } from '../api/types'
import { deriveRunViewModel } from '../lib/run-view-model'
import { useRuns } from '../state/RunsContext'
import { isActiveRunStatus } from '../../../../shared/run-state'
import { EvaluationExportTaskStatus } from './EvaluationExportTaskToast'
import { WizardTaskStatus } from './WizardTaskStatus'
import { StatusDot, type StatusDotState } from './config/atoms'

interface Props {
  activeRunDetail: RunDetail | null
  onNavigateToRun?: (feature: string, runId: string) => void
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
export function GlobalStatusBar({ activeRunDetail, onNavigateToRun }: Props) {
  const { connection } = useRuns()
  const status = activeRunDetail?.manifest.status
  const view = deriveRunViewModel(activeRunDetail)

  // Guard: only treat 'running' and 'healing' as truly active. The runs
  // index can become stale if the orchestrator crashes, so double-check the
  // manifest status from the detail endpoint.
  const isActive = isActiveRunStatus(status)
  const services = activeRunDetail?.manifest.services ?? []

  // While healing, Playwright is NOT running (it's been killed) — but the
  // run as a whole is mid-cycle. Reflect that with a dedicated 'healing'
  // chip rather than showing "Paused", which implies a resumable Playwright.
  const playwrightState: 'running' | 'healing' | 'idle' = !isActive
    ? 'idle'
    : status === 'running'
      ? 'running'
      : 'healing'

  const servicesActive = isActive

  return (
    <div className="relative">
      <div
        className="cl-shell-bar flex items-center gap-3 px-4 py-2 overflow-hidden"
      >
      <span
        className="cl-kicker shrink-0 inline-flex items-center gap-2"
      >
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
          style={{ background: 'var(--accent)' }}
        />
        Canary Lab
      </span>
      <span className="cl-divider shrink-0">|</span>
      <ConnectionBadge state={connection} />
      <span className="cl-divider shrink-0">|</span>
      <div className="shrink-0"><StatusChip label="Playwright" state={playwrightState} /></div>
      {services.length > 0 && (
        <div className="shrink-0">
          <StatusChip
            label={`${services.length} service${services.length > 1 ? 's' : ''}`}
            state={servicesActive ? 'running' : 'idle'}
          />
        </div>
      )}
      <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
        {activeRunDetail && isActive && (
          <button
            type="button"
            onClick={() => onNavigateToRun?.(activeRunDetail.manifest.feature, activeRunDetail.manifest.runId)}
            className="cl-button flex min-w-0 max-w-[420px] items-center gap-2 px-2 py-0.5 text-[11px]"
            style={{ color: 'var(--text-secondary)' }}
            title={`Go to active run: ${activeRunDetail.manifest.feature} ${view.headline} ${activeRunDetail.manifest.runId}`}
          >
            <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>Active:</span>
            <span className="truncate" style={{ color: 'var(--text-primary)' }}>{activeRunDetail.manifest.feature}</span>
            <span className="hidden min-w-0 truncate xl:inline" style={{ color: 'var(--text-secondary)' }}>{view.headline}</span>
            <span className="hidden min-w-0 truncate 2xl:inline" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {activeRunDetail.manifest.runId}
            </span>
            <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>→</span>
          </button>
        )}
        <WizardTaskStatus />
        <EvaluationExportTaskStatus />
      </div>
      </div>
      <div aria-hidden="true" className="cl-accent-strip" />
    </div>
  )
}

// Compact pill: green = WS open, amber pulse = reconnecting/connecting,
// rose = disconnected. Sits left of the Playwright/services chips so the
// user sees data freshness at a glance without cluttering the bar.
function ConnectionBadge({
  state,
}: {
  state: 'connecting' | 'live' | 'reconnecting' | 'disconnected'
}) {
  const palette: Record<typeof state, { dot: StatusDotState; text: string; label: string; pulse: boolean }> = {
    live:         { dot: 'success', text: 'text-emerald-700/90 dark:text-emerald-300/90', label: 'live',         pulse: false },
    connecting:   { dot: 'warning', text: 'text-amber-700/90 dark:text-amber-300/90',     label: 'connecting',   pulse: true },
    reconnecting: { dot: 'warning', text: 'text-amber-700/90 dark:text-amber-300/90',     label: 'reconnecting', pulse: true },
    disconnected: { dot: 'failed',  text: 'text-rose-700/90 dark:text-rose-300/90',       label: 'offline',      pulse: false },
  }
  const p = palette[state]
  return (
    <div
      data-testid="runs-connection-badge"
      data-state={state}
      className={`flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-wide ${p.text}`}
      title={`Runs stream: ${p.label}`}
    >
      <StatusDot state={p.dot} pulse={p.pulse} halo={p.pulse} />
      <span>{p.label}</span>
    </div>
  )
}

function StatusChip({ label, state }: { label: string; state: 'running' | 'healing' | 'idle' }) {
  const dotState: StatusDotState =
    state === 'running' ? 'success'
    : state === 'healing' ? 'warning'
    : 'idle'
  return (
    <div className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
      <StatusDot state={dotState} pulse={state !== 'idle'} halo={state !== 'idle'} />
      <span>{label}</span>
      <span className="uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {state}
      </span>
    </div>
  )
}
