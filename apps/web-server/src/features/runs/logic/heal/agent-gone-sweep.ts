import { EXTERNAL_AGENT_GONE_MS } from '../../../../../../../shared/run-state'
import { clientKindLabel } from '../../../../../../../shared/run-mode'
import type { ExternalHealSession } from '../../../../../../../shared/run-manifest'
import type { CancelHealResult, HealEnding } from '../run-control-results'

export interface SweepRunner {
  isWaitingForHealSignal?(): boolean
  cancelHeal(ending?: HealEnding): Promise<CancelHealResult>
}

/**
 * End the heal of every run whose claimed external agent has been silent for
 * `EXTERNAL_AGENT_GONE_MS`. The claim already reads `disconnected` after
 * `HEARTBEAT_STALE_MS`; the run itself only waited on the 24-hour signal
 * ceiling, so a vanished agent left it in `healing` until a human noticed.
 * Only a run parked on the agent's signal is ended — a rerun in flight settles
 * on its own verdict first. Returns the runIds whose heal was ended.
 */
export async function sweepGoneHealAgents(
  broker: { listClaims(): Array<{ runId: string; session: ExternalHealSession }> },
  registry: { get(runId: string): SweepRunner | undefined },
  nowMs: number,
): Promise<string[]> {
  const ended: string[] = []
  for (const { runId, session } of broker.listClaims()) {
    const last = Date.parse(session.lastHeartbeatAt)
    if (!Number.isFinite(last) || nowMs - last <= EXTERNAL_AGENT_GONE_MS) continue
    const runner = registry.get(runId)
    if (!runner?.isWaitingForHealSignal?.()) continue
    const result = await runner.cancelHeal({
      kind: 'agent-disconnected',
      client: clientKindLabel(session.clientKind, 'The repair agent'),
      lastHeartbeatAt: session.lastHeartbeatAt,
    })
    if (result.ok) ended.push(runId)
  }
  return ended
}
