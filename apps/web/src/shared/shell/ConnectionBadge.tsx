import { StatusDot, type StatusDotState } from '../../features/config/components/atoms'

// Compact pill: green = WS open, amber pulse = reconnecting/connecting,
// rose = disconnected. Sits left of the MCP/services chips so the
// user sees data freshness at a glance without cluttering the bar.
export function ConnectionBadge({
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
      className={`flex shrink-0 items-center gap-1.5 ${p.text}`}
      style={{ fontSize: 11.5, fontWeight: 500 }}
      title={`Runs stream: ${p.label}`}
    >
      <StatusDot state={p.dot} pulse={p.pulse} halo={p.pulse} />
      <span>{p.label}</span>
    </div>
  )
}
