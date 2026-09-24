import { z } from 'zod'
import { type ToolGroupContext, asJsonResult, errorResult } from '../tool-support'

export function registerCoverageChangeTools({ registerTool, deps }: ToolGroupContext): void {
  registerTool('wait_for_feature_change', {
    description: 'Read current coverage freshness and its next necessary action for your suite, or wait up to 30 seconds after a known revision. Detects docs, tests, dependencies, and run evidence changes without a browser refresh. Use the returned revision on the next wait; after reconnecting, omit it to catch up. A changed revision is not permission to launch work: honor the user task and active job/Flight owner. Passive MCP clients cannot be woken unsolicited; use this wait while actively monitoring and check coverageUpdate in relevant tool replies.',
    inputSchema: {
      feature: z.string(),
      afterRevision: z.string().optional(),
      timeout_ms: z.number().int().min(0).max(30_000).default(30_000),
    },
  }, async ({ feature, afterRevision, timeout_ms }) => {
    if (!deps.coverageRequest) return errorResult('Coverage change observation is unavailable on this server')
    const query = new URLSearchParams({ timeoutMs: String(timeout_ms), ...(afterRevision ? { afterRevision } : {}) })
    const result = await deps.coverageRequest({ method: 'GET', url: `/api/features/${encodeURIComponent(feature)}/coverage/changes?${query}` })
    return result.statusCode >= 400 ? errorResult(JSON.stringify(result.body)) : asJsonResult(result.body)
  })
}
