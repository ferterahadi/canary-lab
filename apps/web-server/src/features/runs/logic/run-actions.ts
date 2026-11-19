import type { RunDetail } from '../../../../../../shared/run-detail'
import { deriveRunActionAvailability, isActiveRunStatus, isTerminalRunStatus } from '../../../../../../shared/run-state'
import type { ExternalHealBroker } from './heal/external-heal-broker'
import { withSingleAttemptDetailState } from './single-attempt-view'

/** Capability reads include historical receipts; mutations still enforce their own guards. */
export function buildRunActionsResponse(
  detail: RunDetail,
  logsDir: string,
  externalClaim: ReturnType<ExternalHealBroker['getSession']>,
) {
  const current = withSingleAttemptDetailState(detail, logsDir)
  const { status, executionType, healEnd } = current.manifest
  const newRunRequired = current.newRunRequired === true || healEnd?.reason === 'new-run-required'
  const active = isActiveRunStatus(status)
  const availability = deriveRunActionAvailability(status, null, { executionType, newRunRequired })
  if (current.collaboration) availability.restartHeal = {
    enabled: current.collaboration.continuation.available,
    ...(current.collaboration.continuation.reason ? { reason: current.collaboration.continuation.reason } : {}),
  }
  return {
    status,
    collaboration: current.collaboration,
    availability,
    signal: { rerun: active, restart: active, heal: active },
    evaluationExport: { available: isTerminalRunStatus(status) },
    externalClaim,
  }
}
