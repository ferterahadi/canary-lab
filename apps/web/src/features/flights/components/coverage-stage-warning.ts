import type { CoverageFreshness } from '@shared/coverage/freshness'
import type { FlightStageKey } from '@/shared/api/client'
import { coverageWarning } from '@/shared/ui/CoverageFreshnessIndicator'
import { stageRowKey } from './StageRail'

export interface CoverageStageWarning {
  message: string
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

  return { message, ...(nextActionRow ? { nextActionRow } : {}) }
}

export function isCoverageWarningRow(key: FlightStageKey, warning: CoverageStageWarning | undefined): boolean {
  return warning !== undefined && (key === 'specs-coverage' || key === warning.nextActionRow)
}
