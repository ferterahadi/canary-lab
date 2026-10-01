import { assessPolicy } from './attribution'
import type { Attempt, ExecutionResult, UsageAttribution } from './types'

export function recoverWorkerEvidence(result: ExecutionResult, attempt: Attempt, attribution: UsageAttribution): ExecutionResult {
  return { ...result, attribution, usage: attribution.total,
    ...(attempt.variant && !result.adherence ? { adherence: assessPolicy(attempt.variant.diagnosisPolicy, attribution) } : {}) }
}
