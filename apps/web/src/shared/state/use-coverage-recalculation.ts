import { useCallback, useRef, useState } from 'react'
import type { CoverageRecoveryStage } from '@shared/coverage/freshness'
import type { CoverageJobIndexEntry } from '@shared/coverage/types'
import type { AgentStagePlans, ModelAgentKind } from '@shared/agent-models'
import * as coverageApi from '@/shared/api/coverage'
import { ApiError } from '@/shared/api/internal'
import { displayError } from '@/shared/api/error-message'

/** What the models gate confirmed for a coverage launch: the override and the
 *  agent it was chosen for, so the server reads it in that agent's vocabulary. */
export interface CoverageLaunchModels {
  agent: ModelAgentKind
  models: AgentStagePlans
}

export interface CoverageRecalculation {
  feature: string
  stage: CoverageRecoveryStage
  /** Kept so a retry relaunches with the models already confirmed, rather
   *  than silently falling back to the saved defaults. */
  launchModels?: CoverageLaunchModels
  request: number
  status: 'starting' | 'started' | 'failed'
  error?: string
}

/** App owns launches because opening Flight unmounts the coverage ledger. */
export function useCoverageRecalculation({ jobs, hasActiveFlight, openRequirements, invalidate }: {
  jobs: CoverageJobIndexEntry[]
  hasActiveFlight: (feature: string) => boolean
  openRequirements: (feature: string) => void
  invalidate: () => void
}) {
  const [launch, setLaunch] = useState<CoverageRecalculation | null>(null)
  const pending = useRef(new Set<string>())
  const sequence = useRef(0)
  const start = useCallback((feature: string, stage: CoverageRecoveryStage, launchModels?: CoverageLaunchModels) => {
    if (stage === 'run' || pending.current.has(feature)) return
    pending.current.add(feature)
    const request = ++sequence.current
    setLaunch({ feature, stage, launchModels, request, status: 'starting' })
    openRequirements(feature)
    const begin = async () => {
      try {
        const active = jobs.find((job) => job.feature === feature && job.status === 'running')
        if (!active && !hasActiveFlight(feature)) {
          try {
            await coverageApi.startCoverageJob(
              feature,
              stage === 'prd-summary' ? 'summary' : 'coverage',
              launchModels ? { adapter: launchModels.agent, models: launchModels.models } : undefined,
            )
          } catch (error) {
            const existing = error instanceof ApiError && error.status === 409
              ? (error.body as { existingJobId?: string } | null)?.existingJobId : undefined
            if (!existing) throw error
            await coverageApi.getCoverageJob(existing)
          }
        }
        invalidate()
        setLaunch((current) => current?.request === request ? { ...current, status: 'started' } : current)
      } catch (error) {
        setLaunch((current) => current?.request === request
          ? { ...current, status: 'failed', error: displayError(error) } : current)
      } finally {
        pending.current.delete(feature)
      }
    }
    // begin owns both launch failures and cleanup; navigation never cancels it.
    void begin()
  }, [jobs, hasActiveFlight, openRequirements, invalidate])
  return { launch, start }
}
