import type { CoverageFreshness } from '@shared/coverage/freshness'
import { AlertCircleIcon } from './Icons'
import { Tooltip } from './Tooltip'

/** One explanation for the rail, metric tiles and ledger; freshness never changes
 * the saved measurement, but must qualify it wherever that measurement appears. */
export function coverageWarning(freshness: CoverageFreshness | undefined, confirmed: boolean, error?: string | null): string | undefined {
  if (confirmed && freshness?.state === 'current' && !freshness.latestRunFailed && !freshness.proofNeedsRun) return undefined
  const title = !confirmed || !freshness ? 'Coverage freshness unconfirmed.'
    : freshness.state === 'current' ? freshness.latestRunFailed ? 'Latest run has failures.' : 'Current tests need verification.'
      : freshness.state === 'updating' ? 'Coverage update in progress.'
        : freshness.state === 'not-measured' ? 'Coverage not measured.'
          : freshness.state === 'unavailable' ? 'Coverage inputs unavailable.' : 'Coverage out of date.'
  return [title, error ?? (confirmed ? freshness?.reasons.join(' ') : 'Checking current inputs.'),
    !confirmed || freshness?.state !== 'current' ? 'Showing results from the last calculation.' : undefined,
  ].filter(Boolean).join(' ')
}

export function CoverageFreshnessIndicator({ message }: { message?: string }) {
  if (!message) return null
  return <Tooltip label={message}>
    <span tabIndex={0} role="img" aria-label={message} data-testid="coverage-freshness-warning"
      className="inline-flex shrink-0 cursor-help text-warning">
      <AlertCircleIcon />
    </span>
  </Tooltip>
}
