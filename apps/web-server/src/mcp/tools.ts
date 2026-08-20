// Canary Lab MCP tool registration.
//
// The tools themselves live in ./tool-groups/, one module per domain section.
// They are NOT split by profile: seven tools (list_features in six) belong to
// several profiles at once, so a per-profile file would mean either duplicate
// registrations or inventing a primary owner. Profile membership is data — the
// arrays in ./tool-support.ts — not file layout.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CLIENT_KIND,
  DEFAULT_CANARY_LAB_MCP_PROFILE,
  FULL_TOOLS,
  TOOLS_BY_PROFILE,
  type CanaryLabMcpDeps,
  type CanaryLabMcpToolName,
  type CanaryLabMcpToolOptions,
} from './tool-support'
import { registerReadTools } from './tool-groups/reads'
import { registerAuthoringTools } from './tool-groups/authoring'
import { registerRunLifecycleTools } from './tool-groups/run-lifecycle'
import { registerHealFlowTools } from './tool-groups/heal-flow'
import { classifyMcpClient, clientKindFromFacts, type McpClientFacts } from './client-surface'

export * from './tool-support'

export function registerCanaryLabTools(
  server: McpServer,
  deps: CanaryLabMcpDeps,
  opts: CanaryLabMcpToolOptions = {},
): void {
  const profile = opts.profile ?? DEFAULT_CANARY_LAB_MCP_PROFILE
  // Read the peer at CALL time, not now: `clientInfo` and the client's declared
  // capabilities only exist after the initialize handshake, which happens after
  // registration. `server.server` is the public underlying Server.
  const clientFacts = (): McpClientFacts =>
    classifyMcpClient(server.server.getClientVersion(), server.server.getClientCapabilities())
  // Also resolved per CALL: when the connect URL carried no client_kind
  // (opts.defaultClientKind undefined), the fallback identity comes from that
  // same handshake. Branding only: clientKindFromFacts never returns a `*-pty`
  // kind, so heal-claim suppression still requires the explicit param the
  // runner's spawn config sets. An explicit tool-call argument beats both —
  // a zod default only fills absence.
  const clientKindInput = CLIENT_KIND.default(
    () => opts.defaultClientKind ?? clientKindFromFacts(clientFacts()),
  )
  const enabled = new Set<CanaryLabMcpToolName>(TOOLS_BY_PROFILE[profile])
  const knownTools = new Set<CanaryLabMcpToolName>(FULL_TOOLS)
  const registerTool: McpServer['registerTool'] = ((name: string, config: unknown, cb: unknown) => {
    const toolName = name as CanaryLabMcpToolName
    if (!knownTools.has(toolName)) {
      throw new Error(`MCP tool is not assigned to a profile: ${name}`)
    }
    if (enabled.has(toolName)) {
      const register = server.registerTool as unknown as (toolName: string, toolConfig: unknown, callback: unknown) => unknown
      register.call(server, name, config, cb)
    }
  }) as McpServer['registerTool']

  const ctx = { registerTool, deps, clientKindInput, clientFacts }
  registerReadTools(ctx)
  registerAuthoringTools(ctx)
  registerRunLifecycleTools(ctx)
  registerHealFlowTools(ctx)
}
