import { z } from 'zod'
import { type ToolGroupContext, asJsonResult, errorResult } from '../tool-support'

export function registerDiscoveryRepairTools({ registerTool, deps, clientKindInput }: ToolGroupContext): void {
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    if (!deps.discoveryRepairRequest) return errorResult('Discovery repair is unavailable on this server')
    const result = await deps.discoveryRepairRequest({ method, url, payload })
    if (result.statusCode >= 400) return errorResult(JSON.stringify(result.body))
    // Activity can grow over many attempts; the UI owns the full rail. MCP
    // callers need the current state and prompt path, not replayed transcripts.
    const compact = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value
      const { log: _log, ...record } = value as Record<string, unknown>
      return record
    }
    return asJsonResult(Array.isArray(result.body) ? result.body.map(compact) : compact(result.body))
  }
  registerTool('start_discovery_repair', {
    description: 'Start or attach to test-discovery repair. External mode claims the repair for your session; poll get_discovery_repair until promptReady, then read promptPath and fix loading only. Report progress with update_discovery_repair and request Canary verification. No test bodies run.',
    inputSchema: { feature: z.string(), mode: z.enum(['external', 'internal']).default('external'), session_id: z.string().min(1), client_kind: clientKindInput, conversation_name: z.string().optional(), external_session_url: z.string().optional() },
  }, async ({ feature, mode, session_id, client_kind, conversation_name, external_session_url }) => {
    if (client_kind === 'claude-pty' || client_kind === 'codex-pty') return errorResult('Runner-spawned agents cannot claim or start discovery repairs')
    return call('POST', `/api/features/${encodeURIComponent(feature)}/discovery-repairs`, mode === 'internal' ? { kind: 'internal' } : { kind: 'external', sessionId: session_id, clientKind: client_kind, conversationName: conversation_name, sessionUrl: external_session_url })
  })
  registerTool('get_discovery_repair', {
    description: 'Read a discovery repair by repairId, or list its feature history. While repairing, wait for promptReady before editing. While verifying, wait without editing. Succeeded means discovery works, not that tests passed. Failed returns the latest diagnostic; resume with start_discovery_repair.',
    inputSchema: { repairId: z.string().optional(), feature: z.string().optional() },
  }, async ({ repairId, feature }) => {
    if (repairId) return call('GET', `/api/discovery-repairs/${encodeURIComponent(repairId)}`)
    if (feature) return call('GET', `/api/features/${encodeURIComponent(feature)}/discovery-repairs`)
    return errorResult('Provide repairId or feature')
  })
  registerTool('update_discovery_repair', {
    description: 'Owner-only external repair update. progress records a concise milestone and heartbeat visible live in Canary. verify means you stopped editing and request Canary-owned Playwright discovery. blocked means you stopped editing and release the repair with a reason. Never report success yourself; read Canary’s result.',
    inputSchema: { repairId: z.string(), session_id: z.string(), action: z.enum(['progress', 'verify', 'blocked']), message: z.string().min(1).max(2000).optional() },
  }, async ({ repairId, session_id, action, message }) => call('POST', `/api/discovery-repairs/${encodeURIComponent(repairId)}`, { sessionId: session_id, action, message }))
}
