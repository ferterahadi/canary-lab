import type {
  Icon,
  ToolAnnotations,
} from '@modelcontextprotocol/server'
import type { z } from 'zod'
import { registerAuthoringTools } from './tool-groups/authoring'
import { registerWorkflowGuideTools } from './tool-groups/guides'
import { registerHealFlowTools } from './tool-groups/heal-flow'
import { registerDiscoveryRepairTools } from './tool-groups/discovery-repair'
import { registerReadTools } from './tool-groups/reads'
import { registerTestReviewTools } from './tool-groups/test-review'
import { registerRunLifecycleTools } from './tool-groups/run-lifecycle'
import { registerCoverageChangeTools } from './tool-groups/coverage-changes'
import { withCoverageCatchup } from './coverage-catchup'
import type { CanaryLabToolHandler } from './tool-schemas'
export type { CanaryLabToolHandler } from './tool-schemas'
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
    captured.set(toolName, { name: toolName, config, handler: withCoverageCatchup(toolName, handler, baseContext.deps) })
  }) as unknown as ToolGroupContext['registerTool']

  const ctx: ToolGroupContext = { ...baseContext, registerTool }
  registerReadTools(ctx)
  registerWorkflowGuideTools(ctx)
  registerAuthoringTools(ctx)
  registerRunLifecycleTools(ctx)
  registerTestReviewTools(ctx)
  registerHealFlowTools(ctx)
  registerDiscoveryRepairTools(ctx)
  registerCoverageChangeTools(ctx)

  const missing = FULL_TOOLS.filter((name) => !captured.has(name))
  if (missing.length > 0) {
    throw new Error(`MCP tools are assigned but not registered: ${missing.join(', ')}`)
  }

  return new Map(FULL_TOOLS.map((name) => [name, captured.get(name)!]))
}
