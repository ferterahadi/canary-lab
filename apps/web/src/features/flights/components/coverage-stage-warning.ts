import type { CoverageFreshness } from '@shared/coverage/freshness'
import type { FlightStageKey } from '@shared/flights/types'
import { coverageWarning } from '@/shared/ui/CoverageFreshnessIndicator'
import { stageRowKey } from './StageRail'

export interface CoverageStageWarning {
  message: string
  label: string
  nextActionRow?: FlightStageKey
}

/** Coverage freshness qualifies both the mapping step and the earliest step
 * that must be repeated. The saved stage statuses remain unchanged. */
export function coverageStageWarning(
  freshness: CoverageFreshness | undefined,
  confirmed: boolean,
  error?: string | null,
): CoverageStageWarning | undefined {
  if (!coverageWarning(freshness, confirmed, error)) return undefined

  const nextActionRow = freshness?.nextAction ? stageRowKey(freshness.nextAction.stage) : undefined
  const message = !confirmed || !freshness ? 'Coverage status unconfirmed.'
    : freshness.state === 'current' ? 'Latest run has failures.'
      : freshness.state === 'updating' ? 'Coverage update in progress.'
        : freshness.state === 'unavailable' ? 'Coverage inputs unavailable.'
          : freshness.state === 'not-measured'
            ? nextActionRow === 'docs' ? 'Requirements missing; coverage not measured.' : 'Coverage not measured.'
            : nextActionRow === 'docs' ? 'Requirements changed; coverage out of date.'
              : freshness.changedTests.length > 0 ? 'Tests changed; coverage out of date.' : 'Coverage out of date.'

  const label = !confirmed || !freshness || freshness.state === 'unavailable' ? 'Unverified'
    : freshness.state === 'updating' ? 'Updating'
      : freshness.state === 'not-measured' ? 'Not measured'
        : freshness.state === 'current' ? 'Run failed' : 'Out of date'
  return { message, label, ...(nextActionRow ? { nextActionRow } : {}) }
}

export function isCoverageWarningRow(key: FlightStageKey, warning: CoverageStageWarning | undefined): boolean {
  return warning !== undefined && (key === 'specs-coverage' || key === warning.nextActionRow)
}
