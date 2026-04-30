import type { RunDetail } from '../api/types'

interface Props {
  activeRunDetail: RunDetail | null
}

// Always-visible top bar showing whether any run is currently active across
// all features. Single source of truth for "is something running right now?"
// — used to gate the Run Now button so we don't spawn concurrent runs that
// would saturate local resources.
export function GlobalStatusBar({ activeRunDetail }: Props) {
  const status = activeRunDetail?.manifest.status
  const services = activeRunDetail?.manifest.services ?? []

  const playwrightState: 'running' | 'paused' | 'idle' = !status
    ? 'idle'
    : status === 'running'
      ? 'running'
      : status === 'healing'
        ? 'paused'
        : 'idle'

  const servicesActive = status === 'running' || status === 'healing'

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
      {activeRunDetail && (
        <div
          className="ml-auto flex items-center gap-2 text-[11px] min-w-0"
          style={{ color: 'var(--text-secondary)' }}
        >
          <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>Active run:</span>
          <span className="truncate" style={{ color: 'var(--text-primary)' }}>{activeRunDetail.manifest.feature}</span>
          <span className="truncate" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {activeRunDetail.manifest.runId}
          </span>
        </div>
      )}
    </div>
  )
}

function StatusDot({ label, state }: { label: string; state: 'running' | 'paused' | 'idle' }) {
  const dotColor =
    state === 'running' ? 'bg-emerald-500'
    : state === 'paused' ? 'bg-amber-500'
    : 'bg-zinc-400 dark:bg-zinc-600'

  const dotGlow =
    state === 'running' ? 'bg-emerald-400'
    : state === 'paused' ? 'bg-amber-400'
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
