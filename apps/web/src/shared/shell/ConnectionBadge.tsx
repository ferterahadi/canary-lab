import { StatusDot, type StatusDotState } from '../../features/config/components/atoms'
import { Chip } from '../ui/StatusChip'

// Compact pill: green = WS open, amber pulse = reconnecting/connecting,
// rose = disconnected. Sits left of the MCP/services chips so the
// user sees data freshness at a glance without cluttering the bar.
export function ConnectionBadge({
  state,
}: {
  state: 'connecting' | 'live' | 'reconnecting' | 'disconnected'
}) {
  const palette: Record<typeof state, { dot: StatusDotState; tone: string; label: string; pulse: boolean }> = {
    live:         { dot: 'success', tone: 'var(--success)', label: 'live',         pulse: false },
    connecting:   { dot: 'warning', tone: 'var(--warning)', label: 'connecting',   pulse: true },
    reconnecting: { dot: 'warning', tone: 'var(--warning)', label: 'reconnecting', pulse: true },
    disconnected: { dot: 'failed',  tone: 'var(--danger)',  label: 'offline',      pulse: false },
  }
  const p = palette[state]
  return (
    <div className="shrink-0" data-testid="runs-connection-badge" data-state={state} title={`Runs stream: ${p.label}`}>
      <Chip
        tone={p.tone}
        icon={<StatusDot state={p.dot} pulse={p.pulse} halo={p.pulse} />}
        label={p.label}
        fontSize={11.5}
        fontWeight={500}
      />
    </div>
  )
}
