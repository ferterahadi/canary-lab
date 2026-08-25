import { capitalizeFirst } from '@/shared/lib/format'
import { StatusDot, type StatusDotState } from '@/shared/ui/atoms'
import { Chip } from '../ui/StatusChip'

// Compact framed chip: green dot = WS open, amber pulse = reconnecting/
// connecting, rose = disconnected. Sits left of the MCP badge and wears the
// same neutral frame (border + px-2 py-0.5 + 11px) so the two read as one
// matched pair in the bar — the dot carries the state, not the text colour.
export function ConnectionBadge({
  state,
}: {
  state: 'connecting' | 'live' | 'reconnecting' | 'disconnected'
}) {
  const palette: Record<typeof state, { dot: StatusDotState; label: string; pulse: boolean }> = {
    live:         { dot: 'success', label: 'live',         pulse: false },
    connecting:   { dot: 'warning', label: 'connecting',   pulse: true },
    reconnecting: { dot: 'warning', label: 'reconnecting', pulse: true },
    disconnected: { dot: 'failed',  label: 'offline',      pulse: false },
  }
  const p = palette[state]
  return (
    // flex, not a bare block: an inline-flex Chip inside a block wrapper sits on
    // a text baseline, so its box lands ~1px below the bar's centre line.
    <div className="flex shrink-0 items-center" data-testid="runs-connection-badge" data-state={state} title={`Runs stream: ${p.label}`}>
      <Chip
        chrome="border"
        labelColor="var(--text-secondary)"
        icon={<StatusDot state={p.dot} pulse={p.pulse} halo={p.pulse} />}
        label={capitalizeFirst(p.label)}
        fontSize={11}
        fontWeight={500}
      />
    </div>
  )
}
