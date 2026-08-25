import { describe, it, expect } from 'vitest'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import { createServer } from '../server'
import type { PtyFactory } from '../features/runs/logic/runtime/pty-spawner'

// The transport layer around the MCP protocol: which session a request is routed
// to, and when that session's slot is handed back.
//
// The session map is the part of `registerMcpRoutes` no protocol-level test
// reaches — a real MCP client only ever walks the happy path, so the map's
// eviction and its three refusals (unknown session, missing header, unknown
// client_kind) are only observable from raw HTTP. `/mcp/health` is the readout:
// `activeSessions` + `clients` report the map's contents, so every assertion
// below is about what the server still holds, not about a line having run.

const inertPtyFactory: PtyFactory = () => ({
  pid: 0,
  onData: () => ({ dispose: () => { /* noop */ } }),
  onExit: () => ({ dispose: () => { /* noop */ } }),
  write: () => { /* noop */ },
  resize: () => { /* noop */ },
  kill: () => { /* noop */ },
})

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')

interface HealthBody {
  activeSessions: number
  clients: Array<{ sessionId: string; name?: string; surface: string; canFanOut: boolean; sampling: boolean }>
}

interface JsonRpcError {
  error: { code: number; message: string }
}

/** Boots Canary Lab, hands the test a listening address, and always closes. */
async function withServer(
  body: (ctx: { app: FastifyInstance; address: string }) => Promise<void>,
): Promise<void> {
  const { app } = await createServer({ projectRoot: PROJECT_ROOT, ptyFactory: inertPtyFactory })
  try {
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    await body({ app, address })
  } finally {
    await app.close()
  }
}

/** A raw initialize handshake — the one request allowed to omit the session id.
 *  Raw rather than through the SDK client because these tests need the minted
 *  session id itself, and the SDK client hides it behind its transport. */
async function initialize(
  address: string,
  pathAndQuery = '/mcp',
  clientName = 'sessions-probe',
): Promise<{ status: number; sessionId: string | null; body: unknown }> {
  const res = await fetch(new URL(pathAndQuery, address), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: clientName, version: '0.0.1' },
      },
    }),
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // An accepted handshake answers as SSE, so the body is only JSON on refusal.
    // The status + parsed-or-raw body is all any assertion here needs.
  }
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), body }
}

async function health(app: FastifyInstance): Promise<HealthBody> {
  const res = await app.inject({ method: 'GET', url: '/mcp/health' })
  expect(res.statusCode).toBe(200)
  return res.json() as HealthBody
}

describe('MCP session routing', () => {
  it('reports the live session and frees its slot on DELETE /mcp', async () => {
    await withServer(async ({ app, address }) => {
      const opened = await initialize(address, '/mcp', 'claude-code/2.1.0')
      expect(opened.status).toBe(200)
      const sessionId = opened.sessionId
      expect(sessionId).toBeTruthy()

      // /mcp/health reads the live handshake rather than guessing: the session
      // is branded from the name the client asserted at initialize, which is
      // the whole point of keeping the McpServer alongside its transport.
      const live = await health(app)
      expect(live.activeSessions).toBe(1)
      expect(live.clients).toEqual([
        {
          sessionId,
          name: 'claude-code/2.1.0',
          version: '0.0.1',
          surface: 'claude-code',
          canFanOut: true,
          sampling: false,
        },
      ])

      const closed = await fetch(new URL('/mcp', address), {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionId as string },
      })
      expect(closed.status).toBe(200)

      // Both maps are emptied, not just the transport one — a session that kept
      // its McpServer entry would keep answering /mcp/health as a live client.
      const after = await health(app)
      expect(after.activeSessions).toBe(0)
      expect(after.clients).toEqual([])
    })
  })

  it('refuses a request naming a session it no longer holds', async () => {
    await withServer(async ({ app }) => {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'mcp-session-id': 'ghost-session' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json() as JsonRpcError).toMatchObject({
        error: { code: -32001, message: 'Unknown MCP session: ghost-session' },
      })
    })
  })

  it('evicts only the closed session when two clients are connected', async () => {
    // The reason cleanup looks the entry up by identity rather than trusting one
    // id: two sessions share the map, so a close that swept more than its own
    // row would silently disconnect an unrelated client. Two live sessions is
    // the only arrangement where that mistake is visible.
    await withServer(async ({ app, address }) => {
      const first = await initialize(address, '/mcp', 'codex-cli')
      const second = await initialize(address, '/mcp', 'canary-lab-probe')
      expect(first.sessionId).toBeTruthy()
      expect(second.sessionId).not.toBe(first.sessionId)
      expect((await health(app)).activeSessions).toBe(2)

      const closed = await fetch(new URL('/mcp', address), {
        method: 'DELETE',
        headers: { 'mcp-session-id': first.sessionId as string },
      })
      expect(closed.status).toBe(200)

      const after = await health(app)
      expect(after.activeSessions).toBe(1)
      expect(after.clients.map((c) => c.sessionId)).toEqual([second.sessionId])
    })
  })

  it('refuses a non-initialize request that carries no session id', async () => {
    await withServer(async ({ app }) => {
      // A GET is the SSE stream — it can only attach to a session that already
      // exists, so with no header there is nothing to attach to.
      const stream = await app.inject({ method: 'GET', url: '/mcp' })
      expect(stream.statusCode).toBe(400)
      expect((stream.json() as JsonRpcError).error).toMatchObject({ code: -32600 })
      expect((stream.json() as JsonRpcError).error.message).toContain('missing mcp-session-id header')

      // Same refusal for a POST that isn't an initialize: only initialize may
      // omit the header, and a session is never minted for anything else.
      const call = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
      expect(call.statusCode).toBe(400)
      expect((await health(app)).activeSessions).toBe(0)
    })
  })

  it('refuses a connect URL whose client_kind is not a known kind', async () => {
    await withServer(async ({ app, address }) => {
      const res = await initialize(address, '/mcp?client_kind=telepath')
      expect(res.status).toBe(400)
      expect(res.sessionId).toBeNull()
      expect(res.body as JsonRpcError).toMatchObject({
        error: { code: -32602, message: 'invalid MCP client_kind: telepath' },
      })
      // The refusal happens before newSession, so no half-built session is left
      // behind for the next request to find.
      expect((await health(app)).activeSessions).toBe(0)
    })
  })
})
