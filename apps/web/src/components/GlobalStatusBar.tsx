import type { RunDetail } from '../api/types'
import { useRuns } from '../state/RunsContext'

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

  // Guard: only treat 'running' and 'healing' as truly active. The runs
  // index can become stale if the orchestrator crashes, so double-check the
  // manifest status from the detail endpoint.
  const isActive = status === 'running' || status === 'healing'
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
    <div
      className="cl-shell-bar flex items-center gap-4 px-4 py-2 overflow-hidden"
    >
      <span
        className="cl-kicker shrink-0"
      >
        Canary Lab
      </span>
      <span className="cl-divider shrink-0">|</span>
      <ConnectionBadge state={connection} />
      <span className="cl-divider shrink-0">|</span>
      <div className="shrink-0"><StatusDot label="Playwright" state={playwrightState} /></div>
      {services.length > 0 && (
        <div className="shrink-0">
          <StatusDot
            label={`${services.length} service${services.length > 1 ? 's' : ''}`}
            state={servicesActive ? 'running' : 'idle'}
          />
        </div>
      )}
      {activeRunDetail && isActive && (
        <button
          type="button"
          onClick={() => onNavigateToRun?.(activeRunDetail.manifest.feature, activeRunDetail.manifest.runId)}
          className="cl-button ml-auto flex min-w-0 items-center gap-2 px-2 py-0.5 text-[11px]"
          style={{ color: 'var(--text-secondary)' }}
          title="Go to active run"
        >
          <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>Active run:</span>
          <span className="truncate" style={{ color: 'var(--text-primary)' }}>{activeRunDetail.manifest.feature}</span>
          <span className="truncate" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {activeRunDetail.manifest.runId}
          </span>
          <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>→</span>
        </button>
      )}
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
  const palette = {
    live:          { dot: 'bg-emerald-500',  text: 'text-emerald-700/90 dark:text-emerald-300/90', label: 'live',         pulse: false },
    connecting:    { dot: 'bg-amber-500',    text: 'text-amber-700/90 dark:text-amber-300/90',     label: 'connecting',   pulse: true },
    reconnecting:  { dot: 'bg-amber-500',    text: 'text-amber-700/90 dark:text-amber-300/90',     label: 'reconnecting', pulse: true },
    disconnected:  { dot: 'bg-rose-500',     text: 'text-rose-700/90 dark:text-rose-300/90',       label: 'offline',      pulse: false },
  }[state]
  return (
    <div
      data-testid="runs-connection-badge"
      data-state={state}
      className={`flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-wide ${palette.text}`}
      title={`Runs stream: ${palette.label}`}
    >
      <span className="relative flex h-2 w-2">
        {palette.pulse && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${palette.dot} opacity-75`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${palette.dot}`} />
      </span>
      <span>{palette.label}</span>
    </div>
  )
}

function StatusDot({ label, state }: { label: string; state: 'running' | 'healing' | 'idle' }) {
  const dotColor =
    state === 'running' ? 'bg-emerald-500'
    : state === 'healing' ? 'bg-amber-500'
    : 'bg-slate-400 dark:bg-slate-600'

  const dotGlow =
    state === 'running' ? 'bg-emerald-400'
    : state === 'healing' ? 'bg-amber-400'
    : ''

  return (
    <div className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
      <span className="relative flex h-2 w-2">
        {state !== 'idle' && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dotGlow} opacity-75`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dotColor}`} />
      </span>
      <span>{label}</span>
      <span className="uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {state}
      </span>
    </div>
  )
}
