// MCP tools — workflow guides.
//
// A profile's initialize `instructions` are a lead that fits the client's
// delivered window (see INSTRUCTIONS_DELIVERED_WINDOW); the complete guide for
// each workflow is delivered by this tool instead. Compact clients reach it
// through exec like every other command.
import { z } from 'zod'
import { CANARY_LAB_MCP_WORKFLOWS, INSTRUCTIONS_DELIVERED_WINDOW, WORKFLOW_GUIDES } from '../instructions'
import type { ToolGroupContext } from '../tool-support'

export function registerWorkflowGuideTools(ctx: ToolGroupContext): void {
  const { registerTool } = ctx

  registerTool('get_workflow_guide', {
    description: `Read the complete Canary Lab guide for one workflow before driving it. The initialize instructions are only a summary — clients keep at most their first ${INSTRUCTIONS_DELIVERED_WINDOW} characters — so every rule past that point lives here. Call it once for each workflow you have not driven in this session.`,
    inputSchema: {
      workflow: z.enum(CANARY_LAB_MCP_WORKFLOWS).describe('Which workflow guide to read.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ workflow }) => ({ content: [{ type: 'text', text: WORKFLOW_GUIDES[workflow] }] }))
}
