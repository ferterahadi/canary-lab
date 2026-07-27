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
  // An explicit --url pins one instance and --no-autostart says don't chase one;
  // for both, "unreachable" is the answer the caller asked for, so stay fatal.
  // Otherwise the server may simply not be up *yet* — a `canary-lab ui` restart,
  // an install replacing the package — and exiting here hands the client a dead
  // pipe: it sees `write EPIPE` / "could not attach" and has no tools for its
  // whole session, even once the server returns. Serve stdio anyway and let the
  // reconnect loop (which already handles a mid-session drop) find the server.
  const waitForServer = opts.autoStartEligible !== false && (opts.autoStartUi ?? true)
  const reachable = await ensureMcpServerReachable(initialUrl, opts)
  if (!reachable && !waitForServer) return false

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
  // Backing off to 5s lets the same 120 attempts span ~10 minutes instead of 60
  // seconds, which is what a rebuild-and-restart cycle actually costs. A fixed
  // 500ms budget expired long before the UI came back and left the bridge idle.
  const maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 5_000

  let http = createHttp(initialUrl)
  let cachedInitialize: JSONRPCMessage | null = null
  let stdioClosing = false
  let reconnecting = false
  // Whether `http` is live right now. Tracked explicitly rather than inferred
  // from a failed send, so a cold start queues the very first client message
  // instead of handing it to a transport that has never been started.
  let connected = reachable
  // Client messages with no server to forward them to. On a cold start the first
  // of these is the `initialize` whose reply the client is still blocking on.
  const pending: JSONRPCMessage[] = []

  const wireHttp = (transport: BridgeTransport): void => {
    transport.onmessage = (message) => {
      // The client already initialized against the previous server; drop the
      // reply to our internal re-initialize so it never sees a duplicate.
      if (isResponseTo(message, REINIT_ID)) return
      if (isInitializeResult(message)) transport.setProtocolVersion?.(message.result.protocolVersion)
      forwardMessage(stdio, message).catch((err) => transport.onerror?.(err as Error))
    }
    transport.onclose = () => { startReconnect('UI server connection closed') }
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
    const hadServer = connected
    connected = false
    stderr.write(hadServer
      ? `Canary Lab MCP lost the UI server (${reason}); reconnecting…\n`
      : `Canary Lab MCP has no UI server yet (${reason}); waiting…\n`)
    try { await http.close() } catch { /* already closed */ }
    // `reconnecting` must clear on every exit, including a throw out of
    // reResolveUrl — otherwise the guard above wedges the bridge shut and no
    // later client message can ever retrigger the hunt.
    try {
      let delay = reconnectDelayMs
      for (let attempt = 0; attempt < reconnectAttempts && !stdioClosing; attempt += 1) {
        const target = reResolveUrl()
        if ((await checkHealth(target, fetchFn)).ok) {
          const next = createHttp(target)
          wireHttp(next)
          try {
            await next.start()
            // The sentinel re-handshake is only for a client that already holds
            // an initialize *result*. On a cold start its initialize never
            // reached a server, so it is still in `pending` and gets replayed as
            // itself — that reply is the one the client is waiting for and must
            // not be swallowed as a duplicate.
            if (cachedInitialize && !pending.includes(cachedInitialize)) {
              await reinitialize(next)
              // Tell the client to re-list tools against the new server.
              await forwardMessage(stdio, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as JSONRPCMessage)
            }
            http = next
            connected = true
            // Cleared before the replay so a send that fails again can start a
            // fresh hunt instead of being swallowed by the re-entry guard.
            reconnecting = false
            for (const message of pending.splice(0)) sendToServer(message)
            stderr.write(`Canary Lab MCP reconnected at ${stripProfile(target)}\n`)
            return
          } catch (err) {
            stderr.write(`Canary Lab MCP reconnect attempt failed: ${(err as Error).message}\n`)
            try { await next.close() } catch { /* ignore */ }
          }
        }
        await sleep(delay)
        delay = Math.min(delay * 2, maxReconnectDelayMs)
      }
      // Out of attempts: stay idle. The next client message retriggers reconnect.
    } finally {
      reconnecting = false
    }
  }

  const startReconnect = (reason: string): void => {
    reconnect(reason).catch((err) => {
      stderr.write(`Canary Lab MCP reconnect loop failed: ${(err as Error).message}\n`)
    })
  }

  // The one path for every client→server message. A send that cannot land is
  // queued rather than dropped, so an outage costs latency instead of a request
  // the client never gets an answer to.
  const sendToServer = (message: JSONRPCMessage): void => {
    if (!connected) {
      pending.push(message)
      startReconnect('a client message arrived before the UI server')
      return
    }
    forwardMessage(http, message).catch((err) => {
      pending.push(message)
      stdio.onerror?.(err as Error)
      startReconnect('forwarding to UI server failed')
    })
  }

  stdio.onmessage = (message) => {
    if (isInitializeRequest(message)) cachedInitialize = message
    sendToServer(message)
  }
  stdio.onclose = () => {
    stdioClosing = true
    void stdio.close().catch(() => undefined)
    void http.close().catch(() => undefined)
  }
  stdio.onerror = (err) => stderr.write(`Canary Lab MCP stdio error: ${err.message}\n`)

  wireHttp(http)
  if (reachable) {
    await http.start()
  } else {
    // No server to attach to yet. Start serving stdio regardless so the client's
    // pipe has a live reader, and hunt for the server in the background.
    startReconnect('the UI server was not reachable at startup')
  }
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
