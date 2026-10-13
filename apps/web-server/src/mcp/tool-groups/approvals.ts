import { z } from 'zod'
import { errorResult, type ToolGroupContext } from '../tool-support'

export function registerApprovalTools({ registerTool, deps }: ToolGroupContext): void {
  registerTool('wait_for_approval', {
    description: 'Read-only wait for a human answer to the same approval shown in the chat form and Canary Notifications. Returns the original command result after either surface resolves it. Never answers an approval. Repeat on still_waiting; after reconnect use the same approvalId. Expired approvals require resuming the original command.',
    inputSchema: { approvalId: z.string().uuid(), timeout_ms: z.number().int().min(0).max(30_000).default(30_000) },
  }, async ({ approvalId, timeout_ms }) => deps.approvals
    ? deps.approvals.wait(approvalId, timeout_ms) : errorResult('Browser approvals are unavailable on this server.'))
}
