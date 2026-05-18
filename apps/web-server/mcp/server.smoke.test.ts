import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { createServer } from '../server'
import type { PtyFactory } from '../lib/runtime/pty-spawner'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Smoke test for the MCP HTTP server. Boots Canary Lab against the
// templates/project tree, connects a real MCP client over streamable HTTP,
// and verifies the v1 tool surface. Doubles as the "the SDK didn't change
// shape under us" tripwire.

const inertPtyFactory: PtyFactory = () => ({
  pid: 0,
  onData: () => ({ dispose: () => { /* noop */ } }),
  onExit: () => ({ dispose: () => { /* noop */ } }),
  write: () => { /* noop */ },
  resize: () => { /* noop */ },
  kill: () => { /* noop */ },
})

describe('MCP HTTP server (smoke)', () => {
  it('exposes /mcp/health with the registered tool count', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    try {
      const res = await app.inject({ method: 'GET', url: '/mcp/health' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { ok: boolean; server: { name: string }; toolCount: number }
      expect(body.ok).toBe(true)
      expect(body.server.name).toBe('canary-lab')
      // We register at least the core v1 tool set; assert the floor rather
      // than the exact number so this doesn't trip on later additions.
      expect(body.toolCount).toBeGreaterThanOrEqual(12)
    } finally {
      await app.close()
    }
  })

  it('answers tools/list and tools/call over the streamable HTTP transport', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const url = new URL('/mcp', address)
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: {} },
      )
      const transport = new StreamableHTTPClientTransport(url)
      await client.connect(transport)

      // tools/list — every tool we registered should be discoverable.
      const tools = await client.listTools()
      const names = tools.tools.map((t) => t.name).sort()
      // Core v1 surface. Don't assert ordering; just presence.
      for (const required of [
        'list_features',
        'list_runs',
        'get_run',
        'get_run_actions',
        'get_heal_context',
        'wait_for_heal_task',
        'start_run',
        'pause_run',
        'cancel_heal',
        'abort_run',
        'claim_heal',
        'release_heal',
        'heartbeat',
        'signal_run',
        'write_journal',
      ]) {
        expect(names, `tool '${required}' should be registered`).toContain(required)
      }

      // tools/call list_features — should return the templates/project scaffold.
      const result = await client.callTool({ name: 'list_features', arguments: {} })
      const text = (result.content?.[0] as { type: string; text: string } | undefined)?.text ?? ''
      const features = JSON.parse(text) as Array<{ name: string }>
      const featureNames = features.map((f) => f.name).sort()
      expect(featureNames).toContain('broken_todo_api')
      expect(featureNames).toContain('example_todo_api')
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('accepts back-to-back initialize handshakes from independent clients', async () => {
    // Regression for the singleton-transport bug: a single McpServer +
    // StreamableHTTPServerTransport pair flips an "initialized" flag on
    // first handshake and rejects every later initialize with -32600
    // "Server already initialized". That meant exactly one MCP client per
    // Fastify boot. The route must mint a fresh transport per session.
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const url = `${address}/mcp`
      const initBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'regression-probe', version: '0.0.1' },
        },
      })
      const initOnce = async (): Promise<{ status: number; sid: string | null }> => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: initBody,
        })
        // Drain the body so the connection can be reused / cleaned up.
        await res.text()
        return { status: res.status, sid: res.headers.get('mcp-session-id') }
      }
      const first = await initOnce()
      const second = await initOnce()
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(first.sid).toBeTruthy()
      expect(second.sid).toBeTruthy()
      expect(first.sid).not.toBe(second.sid)
    } finally {
      await app.close()
    }
  })

  it('rejects abort_run without confirm: true (schema-level gate)', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const url = new URL('/mcp', address)
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: {} },
      )
      const transport = new StreamableHTTPClientTransport(url)
      await client.connect(transport)

      // Call abort_run with no confirm field — the zod schema requires
      // `confirm: z.literal(true)`, so the SDK should reject the call with
      // an isError result before we ever hit the handler.
      const result = await client.callTool({
        name: 'abort_run',
        arguments: { runId: 'not-a-real-run' },
      })
      expect(result.isError).toBe(true)
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('wait_for_heal_task reports needs_heal, terminal states, and timeout', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-wait-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: {} },
      )
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))

      runStore.bootstrap({
        runId: 'wait-needs-heal',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
      })
      await client.callTool({
        name: 'claim_heal',
        arguments: {
          runId: 'wait-needs-heal',
          session_id: 'sess-1',
          client_kind: 'codex-cli',
        },
      })
      runStore.recordLifecycleEvent('wait-needs-heal', {
        phase: 'waiting-for-signal',
        headline: 'Waiting for heal signal',
        updatedAt: '2026-05-08T00:00:01.000Z',
        activeCycle: 1,
      })
      const needsHeal = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-needs-heal', session_id: 'sess-1', timeout_ms: 1000 },
      })
      expect(JSON.parse((needsHeal.content?.[0] as { text: string }).text)).toMatchObject({
        type: 'needs_heal',
        runId: 'wait-needs-heal',
        cycle: 1,
      })

      runStore.bootstrap({
        runId: 'wait-passed',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'passed',
        healCycles: 0,
        services: [],
      })
      const passed = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-passed', session_id: 'sess-1', timeout_ms: 1000 },
      })
      expect(JSON.parse((passed.content?.[0] as { text: string }).text)).toMatchObject({
        type: 'passed',
        runId: 'wait-passed',
      })

      runStore.bootstrap({
        runId: 'wait-failed',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
      })
      const failed = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-failed', session_id: 'sess-1', timeout_ms: 1000 },
      })
      expect(JSON.parse((failed.content?.[0] as { text: string }).text)).toMatchObject({
        type: 'failed',
        runId: 'wait-failed',
        status: 'failed',
      })

      runStore.bootstrap({
        runId: 'wait-timeout',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'running',
        healCycles: 0,
        services: [],
        healMode: 'external',
      })
      await client.callTool({
        name: 'claim_heal',
        arguments: {
          runId: 'wait-timeout',
          session_id: 'sess-timeout',
          client_kind: 'codex-cli',
        },
      })
      const timeout = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-timeout', session_id: 'sess-timeout', timeout_ms: 10 },
      })
      expect(JSON.parse((timeout.content?.[0] as { text: string }).text)).toMatchObject({
        type: 'timeout',
        runId: 'wait-timeout',
        status: 'running',
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })
})
