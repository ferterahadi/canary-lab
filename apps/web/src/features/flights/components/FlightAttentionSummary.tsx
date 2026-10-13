import { hasFlightAttention, type FlightAttention } from '@shared/flights/attention'
import type { FlightManifest } from '@shared/flights/types'
import type { CoverageFreshness } from '@shared/coverage/freshness'
import { coverageWarningTitle } from '@/shared/ui/CoverageFreshnessIndicator'

function attentionSummary(attention: FlightAttention, coverageTarget: number, freshness: CoverageFreshness | undefined, coverageConfirmed: boolean | undefined): string {
  if (attention.state === 'unavailable') return 'Could not verify current state'
  if (attention.state === 'resolved') return 'Earlier failure resolved by current evidence.'
  if (attention.stage === 'specs-coverage' && coverageConfirmed && freshness && freshness.state !== 'current') {
    const title = freshness.state === 'stale' ? 'Coverage is out of date' : coverageWarningTitle(freshness, true).replace(/\.$/, '')
    return `${title} · Target ${coverageTarget}%`
  }
  return attention.reason
}

/** A short stage explanation. The server owns whether attention is needed;
 * coverage's shared formatter only shortens its evidence for display. */
export function FlightAttentionSummary({ flight, freshness, coverageConfirmed, onViewFailure }: {
  flight: FlightManifest
  freshness?: CoverageFreshness
  coverageConfirmed?: boolean
  onViewFailure?: () => void
}) {
  const attention = flight.attention
  if (!hasFlightAttention(attention)) return null
  const summary = attentionSummary(attention, flight.opts.coverageTarget, freshness, coverageConfirmed)
  return (
    <div data-testid="flight-attention-summary" className="cl-stage-attention-summary text-xs">
      <span className={`min-w-0 line-clamp-2 ${attention.state === 'resolved' ? 'text-secondary' : 'text-warning'}`} title={attention.reason}>{summary}</span>
      {onViewFailure && <button type="button" className="shrink-0 text-secondary text-xs underline underline-offset-2 hover:text-primary" onClick={onViewFailure}>View earlier failure</button>}
    </div>
  )
}
