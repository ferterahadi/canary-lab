// Canary Lab MCP tool registration.
//
// The tools themselves live in ./tool-groups/, one module per domain section.
// tool-registry.ts captures those registrations once, then this file exposes
// either a focused set of atomic tools or the compact single-tool dispatcher.
import type { McpServer } from '@modelcontextprotocol/server'
import {
  CLIENT_KIND,
  DEFAULT_CANARY_LAB_MCP_PROFILE,
  TOOLS_BY_PROFILE,
  type CanaryLabMcpDeps,
  type CanaryLabMcpToolName,
  type CanaryLabMcpToolOptions,
} from './tool-support'
import { classifyMcpClient, clientKindFromFacts, type McpClientFacts } from './client-surface'
import { registerCompactExecTool } from './exec-tool'
import { createCanaryLabToolRegistry, type CanaryLabToolConfig, type CanaryLabToolHandler } from './tool-registry'

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
  const registry = createCanaryLabToolRegistry({ deps, clientKindInput, clientFacts })
  if (profile === 'compact') {
    registerCompactExecTool(server, registry, { onCall: opts.onExecCall })
    return
  }

  const register = server.registerTool as unknown as (
    name: string,
    config: CanaryLabToolConfig,
    callback: CanaryLabToolHandler,
  ) => unknown
  for (const exposedName of TOOLS_BY_PROFILE[profile]) {
    const name = exposedName as CanaryLabMcpToolName
    // The registry refuses to finish when any FULL_TOOLS entry is missing, and
    // every profile is a typed subset of that union.
    const definition = registry.get(name)!
    register.call(server, name, definition.config, definition.handler)
  }
}
