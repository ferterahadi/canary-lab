import { discoveryRepairActive } from '@shared/discovery-repair'
import type { DiscoveryRepairView } from '../api/discovery-repair'
import { AgentSessionView } from '../ui/AgentSessionView'
import { EMPTY_COPY } from '../ui/empty-state-copy'

export function DiscoveryRepairActivity({ repair }: { repair: DiscoveryRepairView }) {
  const active = discoveryRepairActive(repair)
  const owner = repair.owner
  const stale = owner.kind === 'external' && active && Date.now() - Date.parse(repair.heartbeatAt) > 120_000
  return <div className="flex min-h-0 flex-col gap-2" data-testid="discovery-repair-activity">
    <div className="text-xs font-medium">{active ? (repair.status === 'verifying' ? 'Verifying discovery' : 'Repairing discovery') : 'Repair history'}</div>
    {stale && <p className="text-xs text-warning">No recent update from your agent. Continue that session; this repair still belongs to it.</p>}
    <AgentSessionView
      source={owner.kind === 'internal' && repair.sessionRef ? { kind: 'discovery-repair', taskId: repair.id, live: active && repair.status !== 'verifying' } : undefined}
      systemRows={{ pre: repair.log.slice(0, 1), post: repair.log.slice(1) }}
      externalSessions={owner.kind === 'external' ? [{ ...owner, status: active ? 'running' : repair.status === 'succeeded' ? 'done' : 'failed', message: repair.message, startedAt: repair.createdAt, endedAt: repair.endedAt }] : []}
      empty={{ ...EMPTY_COPY.discoveryNoActivity, detail: <span title={repair.message}>{repair.message}</span> }}
    />
  </div>
}
