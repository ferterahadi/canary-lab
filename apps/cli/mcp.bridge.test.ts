import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Writable } from 'stream'
import {
  bridge,
  doctor,
  ensureMcpServerReachable,
  inferClientKindFromProcessLines,
  inferMcpClientKind,
  isDefaultLocalMcpUrl,
  main,
  REINIT_ID,
  resolveDefaultMcpUrl,
  resolveUiProjectRootForMcpAutostart,
  type BridgeTransport,
} from './mcp'
import type { JSONRPCMessage } from '@modelcontextprotocol/server'

class BufferWritable extends Writable {
  chunks: string[] = []
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString())
    callback()
  }
  text(): string {
    return this.chunks.join('')
  }
}

class FakeTransport implements BridgeTransport {
  started = false
  closed = false
  // Set to make sends reject, standing in for a server that went away between
  // the health check and the request — the real transport's POST failing.
  failSend = false
  sent: JSONRPCMessage[] = []
  protocolVersion?: string
  onmessage?: (message: JSONRPCMessage) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  constructor(public url: string) {}
  async start(): Promise<void> { this.started = true }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.failSend) throw new Error('socket hang up')
    this.sent.push(message)
  }
  async close(): Promise<void> { this.closed = true }
  setProtocolVersion(version: string): void { this.protocolVersion = version }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('bridge reconnect', () => {
  // /mcp/health always answers ok; the bridge can connect and reconnect freely.
  const healthyFetch = (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

  it('follows a switched port, re-initializes, and refreshes the client tool list', async () => {
    const created: FakeTransport[] = []
    const stdio = new FakeTransport('stdio')
    const stderr = new BufferWritable()
    let target = 'http://127.0.0.1:7420/mcp?profile=full&client_kind=other'

    const ok = await bridge('http://127.0.0.1:7420/mcp', {
      stderr,
      fetch: healthyFetch,
      createHttpTransport: (url) => { const t = new FakeTransport(url); created.push(t); return t },
      createStdioTransport: () => stdio,
      reResolveUrl: () => target,
      reconnectDelayMs: 1,
      reconnectAttempts: 10,
      autoStartUi: false,
    })

    expect(ok).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0].started).toBe(true)

    // The client initializes through the bridge; the bridge caches it.
    stdio.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } as JSONRPCMessage)
    expect(created[0].sent).toContainEqual(expect.objectContaining({ method: 'initialize', id: 1 }))

    // The running UI moves to a new port, then the old connection drops.
    target = 'http://127.0.0.1:7500/mcp?profile=full&client_kind=other'
    created[0].onclose?.()
    await waitFor(() => created.length === 2)

    const next = created[1]
    expect(next.url).toContain('7500')
    expect(next.started).toBe(true)
    // Re-initialize handshake replayed against the new server (sentinel id),
    // followed by the initialized notification.
    expect(next.sent[0]).toMatchObject({ method: 'initialize', id: REINIT_ID, params: { protocolVersion: '2025-06-18' } })
    expect(next.sent[1]).toMatchObject({ method: 'notifications/initialized' })
    // The client is prompted to re-list tools against the new server.
    expect(stdio.sent).toContainEqual(expect.objectContaining({ method: 'notifications/tools/list_changed' }))

    // The sentinel re-initialize reply is swallowed, never forwarded to client.
    const before = stdio.sent.length
    next.onmessage?.({ jsonrpc: '2.0', id: REINIT_ID, result: {} } as JSONRPCMessage)
    expect(stdio.sent).toHaveLength(before)

    // A normal server response still forwards to the client.
    next.onmessage?.({ jsonrpc: '2.0', id: 2, result: { ok: true } } as JSONRPCMessage)
    expect(stdio.sent).toContainEqual(expect.objectContaining({ id: 2 }))
  })

  it('does not reconnect once the client (stdio) side closes', async () => {
    const created: FakeTransport[] = []
    const stdio = new FakeTransport('stdio')

    await bridge('http://127.0.0.1:7420/mcp', {
      stderr: new BufferWritable(),
      fetch: healthyFetch,
      createHttpTransport: (url) => { const t = new FakeTransport(url); created.push(t); return t },
      createStdioTransport: () => stdio,
      reResolveUrl: () => 'http://127.0.0.1:7420/mcp?profile=full&client_kind=other',
      reconnectDelayMs: 1,
      reconnectAttempts: 10,
      autoStartUi: false,
    })

    stdio.onclose?.()
    created[0].onclose?.()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(created).toHaveLength(1)
    expect(created[0].closed).toBe(true)
  })
})

describe('bridge cold start', () => {
  // A gated /mcp/health: unreachable until the test flips it, so the bridge
  // starts with no server to attach to — the canary-apply window, where the old
  // behaviour was exit(1) and the client got `write EPIPE`.
  function gatedFetch(state: { healthy: boolean }): typeof fetch {
    return (async () => {
      if (!state.healthy) throw new Error('connect ECONNREFUSED')
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  const coldStartOpts = (state: { healthy: boolean }) => ({
    fetch: gatedFetch(state),
    // Auto-start is the production default; stub the spawn so no UI is launched.
    autoStartEligible: true,
    startUi: () => { /* no UI to launch in a unit test */ },
    startupTimeoutMs: 5,
    startupPollMs: 1,
    reResolveUrl: () => 'http://127.0.0.1:7420/mcp?profile=full&client_kind=other',
    reconnectDelayMs: 1,
    maxReconnectDelayMs: 2,
    reconnectAttempts: 500,
  })

  it('serves the client and replays its initialize when the UI arrives late', async () => {
    const state = { healthy: false }
    const created: FakeTransport[] = []
    const stdio = new FakeTransport('stdio')
    const stderr = new BufferWritable()

    const ok = await bridge('http://127.0.0.1:7420/mcp', {
      ...coldStartOpts(state),
      stderr,
      createHttpTransport: (url) => { const t = new FakeTransport(url); created.push(t); return t },
      createStdioTransport: () => stdio,
    })

    // The bridge stays alive instead of exiting, so the client's pipe keeps a
    // live reader and never sees EPIPE.
    expect(ok).toBe(true)
    expect(stdio.started).toBe(true)
    expect(stderr.text()).toContain('has no UI server yet')

    // The client initializes into a bridge that has no server yet. The request
    // must be held, not handed to a transport that was never started.
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } as JSONRPCMessage
    stdio.onmessage?.(initialize)
    expect(created[0].sent).toHaveLength(0)

    state.healthy = true
    await waitFor(() => created.length === 2)
    const live = created[1]

    // Replayed as the client's own request — id 1, not the sentinel — because
    // the reply it is still blocking on has to reach it.
    expect(live.sent).toEqual([initialize])
    expect(live.sent).not.toContainEqual(expect.objectContaining({ id: REINIT_ID }))
    // Nothing to re-list: the client never got a tool list to invalidate.
    expect(stdio.sent).not.toContainEqual(expect.objectContaining({ method: 'notifications/tools/list_changed' }))

    // The server's answer reaches the client, completing the handshake.
    live.onmessage?.({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } } as JSONRPCMessage)
    expect(stdio.sent).toContainEqual(expect.objectContaining({ id: 1 }))
  })

  it('queues every request that arrives during the outage, in order', async () => {
    const state = { healthy: false }
    const created: FakeTransport[] = []
    const stdio = new FakeTransport('stdio')

    await bridge('http://127.0.0.1:7420/mcp', {
      ...coldStartOpts(state),
      stderr: new BufferWritable(),
      createHttpTransport: (url) => { const t = new FakeTransport(url); created.push(t); return t },
      createStdioTransport: () => stdio,
    })

    for (const id of [1, 2, 3]) {
      stdio.onmessage?.({ jsonrpc: '2.0', id, method: 'tools/list' } as JSONRPCMessage)
    }
    expect(created[0].sent).toHaveLength(0)

    state.healthy = true
    await waitFor(() => created.length === 2 && created[1].sent.length === 3)
    expect(created[1].sent.map((m) => (m as { id: number }).id)).toEqual([1, 2, 3])
  })

  it('replays a request that was in flight when the server dropped', async () => {
    const created: FakeTransport[] = []
    const stdio = new FakeTransport('stdio')

    const ok = await bridge('http://127.0.0.1:7420/mcp', {
      ...coldStartOpts({ healthy: true }),
      stderr: new BufferWritable(),
      createHttpTransport: (url) => { const t = new FakeTransport(url); created.push(t); return t },
      createStdioTransport: () => stdio,
    })
    expect(ok).toBe(true)

    // The client handshakes against the live server, so it holds a real
    // initialize result from here on.
    stdio.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } as JSONRPCMessage)
    expect(created[0].sent).toHaveLength(1)

    // The server goes away between the last health check and this request.
    created[0].failSend = true
    stdio.onmessage?.({ jsonrpc: '2.0', id: 2, method: 'tools/call' } as JSONRPCMessage)
    await waitFor(() => created.length === 2)

    // This client already has an initialize result, so the re-handshake uses the
    // sentinel — and the request it is still waiting on is replayed, not lost.
    expect(created[1].sent).toContainEqual(expect.objectContaining({ id: REINIT_ID }))
    await waitFor(() => created[1].sent.some((m) => (m as { id?: number }).id === 2))
  })

  it('stays fatal when --url pins a specific server that is down', async () => {
    const stderr = new BufferWritable()
    const ok = await bridge('http://127.0.0.1:7420/mcp', {
      stderr,
      fetch: gatedFetch({ healthy: false }),
      autoStartEligible: false,
      createStdioTransport: () => new FakeTransport('stdio'),
    })
    expect(ok).toBe(false)
    expect(stderr.text()).toContain('Start the UI first')
  })

  it('will not attach to a server serving an unusable project root', async () => {
    // Making startup non-fatal opened this: the startup guard refused a bogus
    // server, then the reconnect loop attached to the very same one 500ms later.
    // The loop has to hold the same line, and warn once rather than every poll.
    const created: FakeTransport[] = []
    const stdio = new FakeTransport('stdio')
    const stderr = new BufferWritable()
    const usable = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-usable-')))
    fs.mkdirSync(path.join(usable, 'features'))
    const root = { path: '/' }
    const servingRoot = (async () => new Response(JSON.stringify({ ok: true, projectRoot: root.path }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    try {
      const ok = await bridge('http://127.0.0.1:7420/mcp', {
        ...coldStartOpts({ healthy: false }),
        stderr,
        fetch: servingRoot,
        createHttpTransport: (url) => { const t = new FakeTransport(url); created.push(t); return t },
        createStdioTransport: () => stdio,
      })
      expect(ok).toBe(true)

      await waitFor(() => stderr.text().includes('unusable projectRoot "/"'))
      // Reachable the whole time, and still never attached to.
      expect(created).toHaveLength(1)
      expect(created[0].started).toBe(false)
      // Warned once, not once per poll.
      expect(stderr.text().match(/unusable projectRoot/g)).toHaveLength(1)

      // The same server moves to a real workspace root; now it is attachable.
      root.path = usable
      await waitFor(() => created.length === 2)
      expect(created[1].started).toBe(true)
    } finally {
      fs.rmSync(usable, { recursive: true, force: true })
    }
  })

  it('clears the reconnect guard when re-resolving the target throws', async () => {
    const state = { healthy: false }
    const stdio = new FakeTransport('stdio')
    const stderr = new BufferWritable()
    let resolves = 0

    await bridge('http://127.0.0.1:7420/mcp', {
      ...coldStartOpts(state),
      stderr,
      reResolveUrl: () => {
        resolves += 1
        throw new Error('active-servers.json is unreadable')
      },
      createHttpTransport: (url) => new FakeTransport(url),
      createStdioTransport: () => stdio,
    })

    await waitFor(() => stderr.text().includes('reconnect loop failed'))
    expect(resolves).toBe(1)

    // The guard reset, so a later client message starts a fresh hunt rather than
    // being swallowed for the rest of the session.
    stdio.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'tools/list' } as JSONRPCMessage)
    await waitFor(() => resolves === 2)
  })
})
