import type { CoverageFreshness, CoverageRecoveryStage } from '@shared/coverage/freshness'

export function CoverageFreshnessNotice({ freshness, confirmed, error, onRecover, inFlight = false, blockedReason }: {
  freshness?: CoverageFreshness
  confirmed: boolean
  error?: string | null
  onRecover?: (stage: CoverageRecoveryStage) => void
  inFlight?: boolean
  blockedReason?: string
}) {
  if (confirmed && freshness?.state === 'current' && !freshness.latestRunFailed && !freshness.proofNeedsRun) return null
  const title = !confirmed || !freshness ? 'Coverage freshness unconfirmed'
    : freshness.state === 'current' ? freshness.latestRunFailed ? 'Latest run has failures' : 'Current tests need verification'
      : freshness.state === 'updating' ? 'Coverage update in progress'
        : freshness.state === 'not-measured' ? 'Coverage not measured'
          : freshness.state === 'unavailable' ? 'Coverage inputs unavailable' : 'Coverage out of date'
  return <div role="status" data-testid="coverage-freshness-notice" className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2 text-[12px] text-warning">
    <div className="min-w-0 flex-1">
      <div>{title}</div>
      <div className="text-muted">{error ?? (confirmed ? freshness?.reasons.join(' ') : 'Checking current inputs; previous figures are historical.')}</div>
      {blockedReason && <div className="text-muted">{blockedReason}</div>}
    </div>
    {onRecover && freshness?.nextAction && <button type="button" className="cl-button shrink-0" disabled={!confirmed || Boolean(blockedReason) || freshness.state === 'updating'}
      onClick={() => onRecover(freshness.nextAction!.stage)}>
      {inFlight ? freshness.nextAction.label : 'Open flight →'}
    </button>}
  </div>
}
