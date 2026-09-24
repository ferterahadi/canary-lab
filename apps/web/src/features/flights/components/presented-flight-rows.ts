import type { CoverageJobIndexEntry } from '@/shared/api/types'
import type { FlightStageStatus, PortifyIndexEntry } from '@/shared/api/client'
import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'
import { isActivePortify } from '@/features/portify'
import { ACTIVITY_STAGE, type FeatureActivity } from '../state/feature-activity'
import { stageCoverageJobs } from '../lib/coverage-activity'
import { stageRailRows, stageRowKey, type StageRailRow } from './StageRail'

export function activityRowKey(activity?: FeatureActivity) {
  return activity ? stageRowKey(ACTIVITY_STAGE[activity.kind]) : undefined
}

/** One presentation path for the Flight detail rail and every picker mini rail.
 * Live work can supersede a saved stage; it never edits that saved verdict. */
export function presentedFlightRows({
  feature,
  stages,
  activity,
  portifyWorkflows = [],
  coverageJobs = [],
  derivedStages,
  fillMissingStages = false,
}: {
  feature: string
  stages: Array<{ key: string; status: FlightStageStatus; startedAt?: string; evidence?: unknown; checkpoint?: { kind?: string; data?: unknown } }>
  activity?: FeatureActivity
  portifyWorkflows?: PortifyIndexEntry[]
  coverageJobs?: CoverageJobIndexEntry[]
  derivedStages?: Array<{ key: string; status: FlightStageStatus }>
  fillMissingStages?: boolean
}): StageRailRow[] {
  const byKey = new Map(stages.map((stage) => [stage.key, stage]))
  const source = fillMissingStages
    ? [
        ...FLIGHT_STAGE_KEYS.map((key) => byKey.get(key) ?? { key, status: 'pending' as const }),
        ...stages.filter((stage) => !FLIGHT_STAGE_KEYS.some((key) => key === stage.key)),
      ]
    : stages
  const activeRow = activityRowKey(activity)
  let rows = stageRailRows(source)
  if (activeRow) {
    rows = rows.map((row) => row.key === activeRow && row.status !== 'running'
      ? { ...row, status: 'running' as const }
      : row)
  }

  const activePortify = portifyWorkflows.find((workflow) => workflow.feature === feature && isActivePortify(workflow.status))
  if (activePortify) {
    const status = activePortify.status === 'ready-to-save' ? 'waiting-for-approval' as const : 'running' as const
    rows = rows.map((row) => row.key === 'portify' ? { ...row, status } : row)
  }

  return rows.map((row) => {
    const latest = stageCoverageJobs(coverageJobs, feature, row.key).at(-1)
    const recorded = stages.find((stage) => stage.key === (row.key === 'docs' ? 'prd-summary' : row.key))
    if (!latest || (recorded?.startedAt && latest.startedAt < recorded.startedAt)) return row
    if (latest.status === 'running') return { ...row, status: 'running' }
    if (latest.status === 'failed' || latest.status === 'aborted') return { ...row, status: 'failed' }
    const derivedStatus = derivedStages?.find((stage) => stage.key === row.key)?.status
    return derivedStatus ? { ...row, status: derivedStatus } : row
  })
}
