import type { RunDetail } from '../api/types'

interface Props {
  activeRunDetail: RunDetail | null
  onNavigateToRun?: (feature: string, runId: string) => void
}

// Always-visible top bar showing whether any run is currently active across
// all features. Single source of truth for "is something running right now?"
// — used to gate the Run Now button so we don't spawn concurrent runs that
// would saturate local resources.
export function GlobalStatusBar({ activeRunDetail, onNavigateToRun }: Props) {
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
      className="flex items-center gap-4 px-4 py-2 overflow-hidden"
      style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}
    >
      <span
        className="shrink-0 text-[10px] uppercase tracking-wider font-medium"
        style={{ color: 'var(--text-muted)' }}
      >
        Canary Lab
      </span>
      <span className="shrink-0" style={{ color: 'var(--border-default)' }}>|</span>
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
          className="ml-auto flex items-center gap-2 text-[11px] min-w-0 rounded-md px-2 py-0.5 transition-colors duration-150"
          style={{ color: 'var(--text-secondary)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
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

function StatusDot({ label, state }: { label: string; state: 'running' | 'healing' | 'idle' }) {
  const dotColor =
    state === 'running' ? 'bg-emerald-500'
    : state === 'healing' ? 'bg-amber-500'
    : 'bg-zinc-400 dark:bg-zinc-600'

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
