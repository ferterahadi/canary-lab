import type { RunContext } from './run-context'
import { readManifest } from './manifest'
import { recordHealEnd, emitAgentSystemMessage } from './run-heal-agent'
import { recordLifecycle, setStatus } from './run-manifest-writer'
import { claimedSingleAttempt, NEW_RUN_REQUIRED_MESSAGE } from '../../../../shared/single-attempt'

/** A claimed suite attempt cannot verify another repair in this run. Return
 *  control to the normal teardown so its patch survives as unverified work. */
export function finishClaimedAttempt(ctx: RunContext): boolean {
  const policy = readManifest(ctx.paths.manifestPath)?.singleAttempt ?? ctx.feature.singleAttempt
  if (!claimedSingleAttempt(ctx.runDir, policy)) return false
  recordHealEnd(ctx, {
    reason: 'new-run-required',
    cycle: ctx.healCycles,
    message: NEW_RUN_REQUIRED_MESSAGE,
    at: new Date().toISOString(),
  })
  recordLifecycle(ctx, 'agent-healing', 'New run required before verification', {
    detail: NEW_RUN_REQUIRED_MESSAGE,
    severity: 'warning',
    activeCycle: ctx.healCycles,
  })
  emitAgentSystemMessage(ctx, NEW_RUN_REQUIRED_MESSAGE)
  setStatus(ctx, 'failed')
  return true
}
