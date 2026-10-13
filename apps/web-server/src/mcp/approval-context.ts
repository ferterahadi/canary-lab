import { AsyncLocalStorage } from 'node:async_hooks'
import type { ServerContext } from '@modelcontextprotocol/server'
import type { CanaryLabMcpDeps, CanaryLabToolHandler } from './tool-schemas'
import type { ApprovalStore } from './approval-store'

interface ApprovalContext {
  store: ApprovalStore
  command: string
  feature?: string
  uiUrl: string
  resume: (id: string, answer: Record<string, unknown>) => ReturnType<CanaryLabToolHandler>
}
export const approvalContext = new AsyncLocalStorage<ApprovalContext>()

/** Both compact and direct MCP tools enter here, preserving the original
 * command and client when the human answers from another surface. */
export function withApprovals(command: string, handler: CanaryLabToolHandler, deps: CanaryLabMcpDeps): CanaryLabToolHandler {
  // Test review already owns its browser diff, revision-bound receipt and wait
  // contract. A second record would compete with that existing human decision.
  if (!deps.approvals || command === 'review_test_changes') return handler
  return (args, request) => {
    const uiUrl = deps.getUiUrl?.()
    if (!uiUrl) return handler(args, request)
    const feature = typeof args.feature === 'string' ? args.feature
      : typeof args.runId === 'string' ? deps.store.get(args.runId)?.manifest.feature
      : typeof args.workflowId === 'string' ? deps.getPortify?.(args.workflowId)?.feature : undefined
    const run = (context: ServerContext): ReturnType<CanaryLabToolHandler> => approvalContext.run({
      store: deps.approvals!, command, feature, uiUrl,
      resume: (id, answer) => run({ ...request, mcpReq: { ...request.mcpReq,
        requestState: () => id, inputResponses: { answer: { action: 'accept', content: answer } },
      } } as ServerContext),
    }, async () => {
      const result = await handler(args, context)
      const id = context.mcpReq.requestState?.()
      const response = context.mcpReq.inputResponses?.answer
      // Domain guards can stop a resumed command before its form helper runs.
      // Retire that old question instead of leaving an actionable stale form.
      if (typeof id === 'string' && response && typeof response === 'object' && 'action' in response
        && response.action === 'accept' && deps.approvals!.get(id)?.status === 'pending'
        && 'content' in result && !result.isError) {
        deps.approvals!.update(id, { status: 'expired', error: 'The command no longer accepts this decision. Review its current state in the requesting chat.', result })
      }
      return result
    })
    return run(request)
  }
}
