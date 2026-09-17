import type { CanaryLabMcpDeps, CanaryLabToolHandler } from './tool-schemas'
import { coverageJobStore } from '../features/coverage/logic/coverage/jobs/store'

/** Both compact exec and direct profiles go through this wrapper. Tool results
 * reach agent context even when the host ignores resource notifications. */
export function withCoverageCatchup(name: string, handler: CanaryLabToolHandler, deps: CanaryLabMcpDeps): CanaryLabToolHandler {
  if (!deps.coverageRequest || name === 'wait_for_feature_change') return handler
  return async (args, context) => {
    const result = await handler(args, context)
    if (!('content' in result) || !Array.isArray(result.content)) return result
    let feature = typeof args.feature === 'string' ? args.feature : typeof args.featureId === 'string' ? args.featureId : undefined
    if (!feature && typeof args.runId === 'string') feature = deps.store.get(args.runId)?.manifest.feature
    if (!feature && typeof args.jobId === 'string') feature = coverageJobStore(deps.store.logsDir).get(args.jobId)?.feature
    if (!feature) {
      const content = result.content.find((item) => item.type === 'text')
      if (content?.type === 'text') {
        try {
          const body = JSON.parse(content.text)
          const candidate = body.feature ?? body.manifest?.feature ?? body.flight?.feature
          if (typeof candidate === 'string') feature = candidate
        } catch { /* Non-JSON replies carry no suite association. */ }
      }
    }
    if (!feature) return result
    let update: unknown
    try {
      const response = await deps.coverageRequest!({ method: 'GET', url: `/api/features/${encodeURIComponent(feature)}/coverage/changes?timeoutMs=0` })
      update = response.statusCode < 400 ? response.body : { feature, state: 'unavailable', reason: 'Cannot confirm coverage freshness.', detail: response.body }
    } catch (error) {
      update = { feature, state: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
    return { ...result, content: [...result.content, { type: 'text' as const, text: JSON.stringify({ coverageUpdate: update, guidance: 'Use current freshness, not historical percentages. If recovery is within your task, follow nextAction after respecting activeJobId and Flight ownership; otherwise report it. Save the revision for wait_for_feature_change.' }) }] }
  }
}
