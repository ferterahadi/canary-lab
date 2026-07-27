import { describe, expect, it, vi } from 'vitest'
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

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

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
  sent: JSONRPCMessage[] = []
  protocolVersion?: string
  onmessage?: (message: JSONRPCMessage) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  constructor(public url: string) {}
  async start(): Promise<void> { this.started = true }
  async send(message: JSONRPCMessage): Promise<void> { this.sent.push(message) }
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
