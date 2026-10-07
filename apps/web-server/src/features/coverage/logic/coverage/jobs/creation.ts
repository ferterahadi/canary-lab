import crypto from 'crypto'
import type { CoverageJobKind, CoverageJobManifest } from '../../../../../../../../shared/coverage/types'
import type { CoverageJobStore } from './store'

export class CoverageJobConflictError extends Error {
  readonly statusCode = 409
  constructor(public readonly feature: string, public readonly kind: CoverageJobKind, public readonly existingJobId: string) {
    super(`a ${kind} job is already running for ${feature}`)
    this.name = 'CoverageJobConflictError'
  }
}

export function assertCoverageJobAvailable(store: Pick<CoverageJobStore, 'activeFor'>, feature: string, kind: CoverageJobKind): void {
  const active = store.activeFor(feature, kind)
  if (active) throw new CoverageJobConflictError(feature, kind, active.jobId)
}

type InitialCoverageJob = Pick<CoverageJobManifest, 'jobId' | 'feature' | 'kind' | 'status' | 'startedAt' | 'log'>

// Construction is separate from admission: external coverage builds its context
// between them, and a context failure must not create a job or consume an ID.
export function createCoverageJobManifest(
  args: Pick<CoverageJobManifest, 'feature' | 'kind' | 'log'>,
  deps: { now?: () => string; newJobId?: () => string },
): InitialCoverageJob {
  const { newJobId, now } = deps
  return {
    jobId: newJobId ? newJobId() : `cj_${crypto.randomBytes(6).toString('hex')}`,
    feature: args.feature,
    kind: args.kind,
    status: 'running',
    startedAt: now ? now() : new Date().toISOString(),
    log: args.log,
  }
}
