import type {
  CallToolResult,
  Icon,
  InputRequiredResult,
  ServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server'
import type { z } from 'zod'
import { registerAuthoringTools } from './tool-groups/authoring'
import { registerHealFlowTools } from './tool-groups/heal-flow'
import { registerReadTools } from './tool-groups/reads'
import { registerRunLifecycleTools } from './tool-groups/run-lifecycle'
import {
  FULL_TOOLS,
  type CanaryLabMcpToolName,
  type ToolGroupContext,
} from './tool-support'

export interface CanaryLabToolConfig {
  title?: string
  description?: string
  inputSchema: z.ZodRawShape
  outputSchema?: z.ZodRawShape | z.ZodType
  annotations?: ToolAnnotations
  icons?: Icon[]
  _meta?: Record<string, unknown>
}

export type CanaryLabToolHandler = (
  args: Record<string, unknown>,
  ctx: ServerContext,
) => CallToolResult | InputRequiredResult | Promise<CallToolResult | InputRequiredResult>

export interface CanaryLabToolDefinition {
  name: CanaryLabMcpToolName
  config: CanaryLabToolConfig
  handler: CanaryLabToolHandler
}

type ToolRegistryContext = Omit<ToolGroupContext, 'registerTool'>

/**
 * Capture the existing atomic registrations as data. The same definitions feed
 * both the direct profiles and the compact dispatcher, so adding a tool cannot
 * create a second handler or a second input contract.
 */
export function createCanaryLabToolRegistry(
  baseContext: ToolRegistryContext,
): ReadonlyMap<CanaryLabMcpToolName, CanaryLabToolDefinition> {
  const knownTools = new Set<CanaryLabMcpToolName>(FULL_TOOLS)
  const captured = new Map<CanaryLabMcpToolName, CanaryLabToolDefinition>()

  const registerTool = ((name: string, config: CanaryLabToolConfig, handler: CanaryLabToolHandler) => {
    const toolName = name as CanaryLabMcpToolName
    if (!knownTools.has(toolName)) {
      throw new Error(`MCP tool is not assigned to a profile: ${name}`)
    }
    if (captured.has(toolName)) {
      throw new Error(`MCP tool is registered more than once: ${name}`)
    }
    captured.set(toolName, { name: toolName, config, handler })
  }) as unknown as ToolGroupContext['registerTool']

  const ctx: ToolGroupContext = { ...baseContext, registerTool }
  registerReadTools(ctx)
  registerAuthoringTools(ctx)
  registerRunLifecycleTools(ctx)
  registerHealFlowTools(ctx)

  const missing = FULL_TOOLS.filter((name) => !captured.has(name))
  if (missing.length > 0) {
    throw new Error(`MCP tools are assigned but not registered: ${missing.join(', ')}`)
  }

  return new Map(FULL_TOOLS.map((name) => [name, captured.get(name)!]))
}
