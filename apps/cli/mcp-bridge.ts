import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { type CanaryLabMcpProfile } from '../web-server/src/mcp/tools'
import { DEFAULT_MCP_PROFILE, McpCommandOptions, resolveDefaultMcpUrl, stripProfile } from './mcp'
import { inferMcpClientKind } from './mcp-client-kind'
import { checkHealth, ensureMcpServerReachable, sleep, urlWithContext } from './mcp-reachability'

// Structural transport shape shared by the SDK's stdio + streamable-HTTP
// transports — just enough for the bridge to forward and reconnect.
export interface BridgeTransport {
  start(): Promise<void>
  send(message: JSONRPCMessage): Promise<void>
  close(): Promise<void>
  onmessage?: (message: JSONRPCMessage) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  setProtocolVersion?: (version: string) => void
}

// Sentinel id for the bridge's internal re-initialize handshake on reconnect.
// Its response is swallowed so the client never sees a second initialize reply.
export const REINIT_ID = '__canary-lab-reinit__'

export async function bridge(url: string, opts: McpCommandOptions = {}): Promise<boolean> {
  const stderr = opts.stderr ?? process.stderr
  const fetchFn = opts.fetch ?? fetch
  const profile = opts.profile ?? DEFAULT_MCP_PROFILE
  const clientKind = opts.clientKind ?? inferMcpClientKind() ?? 'other'
  const initialUrl = urlWithContext(url, profile, clientKind)
  if (!await ensureMcpServerReachable(initialUrl, opts)) return false

  const createHttp = opts.createHttpTransport
    ?? ((target: string) =>
      new StreamableHTTPClientTransport(new URL(target), { fetch: fetchFn }) as unknown as BridgeTransport)
  const stdio: BridgeTransport = opts.createStdioTransport
    ? opts.createStdioTransport()
    : (new StdioServerTransport(opts.stdin, opts.stdout) as unknown as BridgeTransport)

  // When reconnecting, re-resolve the target. An explicit --url pins the same
  // server; otherwise re-read the live-server record so a switched port (or
  // relaunched UI) is followed without restarting the client.
  const reResolveUrl = opts.reResolveUrl
    ?? (opts.autoStartEligible === false
      ? () => initialUrl
      : () => urlWithContext(
          resolveDefaultMcpUrl({ cwd: opts.cwd, homeDir: opts.homeDir, registry: opts.registry }),
          profile,
          clientKind,
        ))
  const reconnectAttempts = opts.reconnectAttempts ?? 120
  const reconnectDelayMs = opts.reconnectDelayMs ?? 500

  let http = createHttp(initialUrl)
  let cachedInitialize: JSONRPCMessage | null = null
  let stdioClosing = false
  let reconnecting = false

  const wireHttp = (transport: BridgeTransport): void => {
    transport.onmessage = (message) => {
      // The client already initialized against the previous server; drop the
      // reply to our internal re-initialize so it never sees a duplicate.
      if (isResponseTo(message, REINIT_ID)) return
      if (isInitializeResult(message)) transport.setProtocolVersion?.(message.result.protocolVersion)
      forwardMessage(stdio, message).catch((err) => transport.onerror?.(err as Error))
    }
    transport.onclose = () => { void reconnect('UI server connection closed') }
    transport.onerror = (err) => { stderr.write(`Canary Lab MCP HTTP error: ${err.message}\n`) }
  }

  const reinitialize = async (transport: BridgeTransport): Promise<void> => {
    const params = (cachedInitialize as { params?: unknown } | null)?.params
    await transport.send({ jsonrpc: '2.0', id: REINIT_ID, method: 'initialize', params } as JSONRPCMessage)
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage)
  }

  const reconnect = async (reason: string): Promise<void> => {
    if (stdioClosing || reconnecting) return
    reconnecting = true
    stderr.write(`Canary Lab MCP lost the UI server (${reason}); reconnecting…\n`)
    try { await http.close() } catch { /* already closed */ }
    for (let attempt = 0; attempt < reconnectAttempts && !stdioClosing; attempt += 1) {
      const target = reResolveUrl()
      if ((await checkHealth(target, fetchFn)).ok) {
        const next = createHttp(target)
        wireHttp(next)
        try {
          await next.start()
          if (cachedInitialize) await reinitialize(next)
          // Tell the client to re-list tools against the new server.
          await forwardMessage(stdio, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as JSONRPCMessage)
          http = next
          reconnecting = false
          stderr.write(`Canary Lab MCP reconnected at ${stripProfile(target)}\n`)
          return
        } catch (err) {
          stderr.write(`Canary Lab MCP reconnect attempt failed: ${(err as Error).message}\n`)
          try { await next.close() } catch { /* ignore */ }
        }
      }
      await sleep(reconnectDelayMs)
    }
    // Out of attempts: stay idle. The next client message retriggers reconnect.
    reconnecting = false
  }

  stdio.onmessage = (message) => {
    if (isInitializeRequest(message)) cachedInitialize = message
    forwardMessage(http, message).catch((err) => {
      stdio.onerror?.(err as Error)
      void reconnect('forwarding to UI server failed')
    })
  }
  stdio.onclose = () => {
    stdioClosing = true
    void stdio.close().catch(() => undefined)
    void http.close().catch(() => undefined)
  }
  stdio.onerror = (err) => stderr.write(`Canary Lab MCP stdio error: ${err.message}\n`)

  wireHttp(http)
  await http.start()
  await stdio.start()
  return true
}

export async function forwardMessage(
  transport: { send(message: JSONRPCMessage): Promise<void> },
  message: JSONRPCMessage,
): Promise<void> {
  await transport.send(message)
}

export function requiredToolsForProfile(profile: CanaryLabMcpProfile): string[] {
  if (profile === 'author') return ['create_feature', 'start_external_draft']
  if (profile === 'coverage') return ['start_external_summary', 'start_external_coverage', 'get_feature_coverage']
  if (profile === 'export') return ['start_external_evaluation_export']
  if (profile === 'flight') return ['start_flight', 'respond_flight_checkpoint']
  if (profile === 'verify') return ['execute_verification']
  if (profile === 'portify') return ['start_portify', 'submit_external_portify']
  if (profile === 'lifecycle') return ['wait_for_heal_task', 'create_feature', 'execute_verification']
  if (profile === 'full') return ['wait_for_heal_task', 'start_external_evaluation_export', 'execute_verification']
  return ['wait_for_heal_task']
}

export function isInitializeResult(message: JSONRPCMessage): message is JSONRPCMessage & {
  result: { protocolVersion: string }
} {
  return 'result' in message &&
    !!message.result &&
    typeof message.result === 'object' &&
    'protocolVersion' in message.result &&
    typeof (message.result as { protocolVersion?: unknown }).protocolVersion === 'string'
}

export function isInitializeRequest(message: JSONRPCMessage): boolean {
  return 'method' in message &&
    (message as { method?: unknown }).method === 'initialize' &&
    'id' in message
}

export function isResponseTo(message: JSONRPCMessage, id: string): boolean {
  return 'id' in message &&
    (message as { id?: unknown }).id === id &&
    ('result' in message || 'error' in message)
}
