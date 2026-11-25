import { setTimeout as delay } from 'timers/promises'
import { readRunUpdate } from '../run-catchup'
import { z } from 'zod'
import { readNotificationUpdate } from '../notification-catchup'
import { type ToolGroupContext, asJsonResult, errorResult } from '../tool-support'

export function registerCoverageChangeTools({ registerTool, deps }: ToolGroupContext): void {
  registerTool('wait_for_feature_change', {
    description: 'Read current coverage freshness and its next necessary action for your suite, or wait up to 30 seconds after a known revision. Detects docs, tests, dependencies, and run evidence changes without a browser refresh. Use the returned revision on the next wait; after reconnecting, omit it to catch up. A changed revision is not permission to launch work: honor the user task and active job/Flight owner. Every response includes runUpdate with a separate revision. Supply afterRunRevision and optionally runId to wait for run state as well as coverage; run changes reconcile within one second. Every response also includes notificationUpdate with the current notification revision and actions, including when the coverage wait times out. Notification-only changes do not wake the coverage wait early; servers with Flight attention assessment bound reconciliation responses to 10 seconds. The change includes flightAttention when a Flight exists. A resolved assessment means its historical failure no longer requires action; it does not authorize resuming remaining work. Passive MCP clients cannot be woken unsolicited; use this wait while actively monitoring and check coverageUpdate in relevant tool replies.',
    inputSchema: {
      feature: z.string(),
      afterRevision: z.string().optional(),
      afterRunRevision: z.string().optional().describe('Run-state cursor returned in runUpdate; independent of the coverage cursor.'),
      runId: z.string().optional().describe('Include this run even when it is not among the latest five.'),
      timeout_ms: z.number().int().min(0).max(30_000).default(30_000),
    },
  }, async ({ feature, afterRevision, afterRunRevision, runId, timeout_ms }) => {
    if (!deps.coverageRequest) return errorResult('Coverage change observation is unavailable on this server')
    const deadline = Date.now() + timeout_ms
    let response: { statusCode: number; body: unknown }
    let runUpdate = readRunUpdate(feature, deps, runId)
    do {
      const runChanged = afterRunRevision !== undefined && runUpdate.revision !== afterRunRevision
      const remaining = Math.max(0, deadline - Date.now())
      const wait = runChanged ? 0 : afterRunRevision !== undefined ? Math.min(1000, remaining) : remaining
      const query = new URLSearchParams({ timeoutMs: String(wait), ...(afterRevision ? { afterRevision } : {}) })
      const started = Date.now()
      response = await deps.coverageRequest({ method: 'GET', url: `/api/features/${encodeURIComponent(feature)}/coverage/changes?${query}` })
      runUpdate = readRunUpdate(feature, deps, runId)
      if (response.statusCode >= 400) return errorResult(JSON.stringify(response.body))
      const body = response.body as { changed?: boolean }
      if (afterRunRevision === undefined || runUpdate.revision !== afterRunRevision || body.changed || !afterRevision) break
      if (Date.now() - started < wait) await delay(wait - (Date.now() - started))
    } while (Date.now() < deadline)
    const notificationUpdate = await readNotificationUpdate(feature, deps)
    return asJsonResult({ ...(response.body as Record<string, unknown>), notificationUpdate, runUpdate })
  })
}
