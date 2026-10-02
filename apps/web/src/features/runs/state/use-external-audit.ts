import { isTerminalRunStatus, type RunStatus } from '@shared/run-state'
import { getRunAudit } from '@/shared/api/runs'
import type { AuditEntry } from '@/shared/api/types-wizard'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { useRuns } from './RunsContext'

/** Audit writes have no invalidation event. Active reads reconcile; a terminal
 * transition and connection recovery each request a final current snapshot. */
export function useExternalAudit(runId: string, runStatus: RunStatus): AuditEntry[] {
  const { connection } = useRuns()
  const terminal = isTerminalRunStatus(runStatus)
  const { value } = useLiveResource(null, runId,
    async (id) => (await getRunAudit(id)).entries, {
      cache: 'run-audit',
      refreshKey: JSON.stringify([terminal, connection]),
      pollIntervalMs: 2000,
      pollWhile: (entries) => entries === null || !terminal,
    })
  return value ?? []
}
