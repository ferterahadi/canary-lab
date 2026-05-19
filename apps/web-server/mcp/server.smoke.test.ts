import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import Fastify from 'fastify'
import { createServer } from '../server'
import { registerMcpRoutes } from './server'
import { createRegistry, RunStore } from '../lib/run-store'
import { ExternalHealBroker } from '../lib/external-heal-broker'
import type { PtyFactory } from '../lib/runtime/pty-spawner'
import { runDirFor } from '../lib/runtime/run-paths'
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

async function createMcpHarness(opts: {
  logsDir: string
  projectRoot: string
  featuresDir: string
  startRun?: Parameters<typeof registerMcpRoutes>[1]['startRun']
  restartExternalRun?: Parameters<typeof registerMcpRoutes>[1]['restartExternalRun']
}) {
  const app = Fastify()
  const runStore = new RunStore(opts.logsDir, createRegistry())
  const broker = new ExternalHealBroker({
    now: () => Date.now(),
    emit: (event) => runStore.emit('event', event),
    patchManifest: (runId, patch) => runStore.patchManifest(runId, patch),
    audit: () => {},
  })
  await app.register(registerMcpRoutes, {
    store: runStore,
    broker,
    featuresDir: opts.featuresDir,
    projectRoot: opts.projectRoot,
    startRun: opts.startRun ?? (async () => ({ runId: 'new-run' })),
    restartExternalRun: opts.restartExternalRun,
  })
  return { app, runStore }
}

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
      const knownTests = Array.from({ length: 21 }, (_, index) => ({
        name: `test-${index + 1}`,
        title: `Test ${index + 1}`,
      }))
      fs.writeFileSync(
        path.join(runDirFor(logsDir, 'wait-failed'), 'e2e-summary.json'),
        JSON.stringify({
          complete: true,
          total: 21,
          passed: 3,
          passedNames: ['test-1', 'test-2', 'test-4'],
          knownTests,
          failed: [
            { name: 'test-3', error: { message: 'C failed' } },
            { name: 'test-5', error: { message: 'E failed' } },
          ],
        }),
      )
      const failed = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-failed', session_id: 'sess-1', timeout_ms: 1000 },
      })
      const failedBody = JSON.parse((failed.content?.[0] as { text: string }).text)
      expect(failedBody).toMatchObject({
        type: 'failed',
        runId: 'wait-failed',
        status: 'failed',
        counts: {
          totalKnown: 21,
          passed: 3,
          failed: 2,
          skipped: 0,
          notRun: 16,
          passedNames: ['test-1', 'test-2', 'test-4'],
          failedNames: ['test-3', 'test-5'],
          skippedNames: [],
          notRunNames: [
            'test-6',
            'test-7',
            'test-8',
            'test-9',
            'test-10',
            'test-11',
            'test-12',
            'test-13',
            'test-14',
            'test-15',
            'test-16',
            'test-17',
            'test-18',
            'test-19',
            'test-20',
            'test-21',
          ],
          statusLine: '3/21 passed, 2 failed, 16 not run',
        },
      })
      expect(JSON.stringify(failedBody)).not.toContain('19/21 passed')

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

  it('start_run reuses a healing feature run instead of creating a duplicate', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-reuse-')))
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
        runId: 'reuse-active',
        feature: 'broken_todo_api',
        env: 'local',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
      })

      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-reuse',
          client_kind: 'claude-desktop',
          conversation_name: 'resume existing run',
        },
      })
      const body = JSON.parse((result.content?.[0] as { text: string }).text)
      expect(body).toMatchObject({
        runId: 'reuse-active',
        reused: true,
        status: 'healing',
        claimed: true,
      })
      expect(runStore.list({ feature: 'broken_todo_api' }).map((entry) => entry.runId)).toEqual(['reuse-active'])
      expect(runStore.get('reuse-active')?.manifest.externalHealSession).toMatchObject({
        sessionId: 'sess-reuse',
        clientKind: 'claude-desktop',
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run blocks fresh starts while a matching run is healing', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-block-')))
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
        runId: 'blocking-heal',
        feature: 'broken_todo_api',
        env: 'local',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
      })

      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-block',
          client_kind: 'claude-desktop',
          force_new: true,
        },
      })

      expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
        type: 'active_heal_blocks_start',
        activeRunId: 'blocking-heal',
        activeStatus: 'healing',
      })

      const differentRun = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          run_ref: 'some-other-run',
          claim_heal: true,
          session_id: 'sess-block',
          client_kind: 'claude-desktop',
        },
      })

      expect(JSON.parse((differentRun.content?.[0] as { text: string }).text)).toMatchObject({
        type: 'active_heal_blocks_start',
        activeRunId: 'blocking-heal',
        requestedRunRef: 'some-other-run',
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run prefers an existing run that is waiting for heal over a newer running run', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-heal-first-')))
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
        runId: 'older-waiting-heal',
        feature: 'broken_todo_api',
        env: 'local',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
      })
      runStore.recordLifecycleEvent('older-waiting-heal', {
        phase: 'waiting-for-signal',
        headline: 'Waiting for heal signal',
        updatedAt: '2026-05-08T00:00:01.000Z',
        activeCycle: 1,
      })
      runStore.bootstrap({
        runId: 'newer-running',
        feature: 'broken_todo_api',
        env: 'local',
        startedAt: '2026-05-08T00:01:00.000Z',
        status: 'running',
        healCycles: 0,
        services: [],
      })

      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-heal-first',
          client_kind: 'claude-desktop',
        },
      })

      expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
        runId: 'older-waiting-heal',
        reused: true,
        status: 'healing',
        claimed: true,
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run restarts a failed or aborted run by unique suffix when no run is healing', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-ref-')))
    const featuresDir = path.join(projectRoot, 'features')
    const restarted: Array<{ runId: string; sessionId: string }> = []
    const { app, runStore } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir,
      restartExternalRun: async (runId, healAgent) => {
        restarted.push({ runId, sessionId: healAgent.sessionId })
        runStore.patchManifest(runId, { status: 'running' })
        return { runId }
      },
    })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: {} },
      )
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))

      runStore.bootstrap({
        runId: '2026-05-19T0841-7cvh',
        feature: 'broken_todo_api',
        env: 'local',
        startedAt: '2026-05-19T08:41:00.000Z',
        status: 'aborted',
        healCycles: 3,
        services: [],
        healMode: 'external',
      })

      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          run_ref: '7cvh',
          claim_heal: true,
          session_id: 'sess-restart',
          client_kind: 'claude-desktop',
        },
      })

	      expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
	        runId: '2026-05-19T0841-7cvh',
	        reused: true,
	        restarted: true,
	        mode: 'remaining',
	        counts: {
	          totalKnown: 0,
	          passed: 0,
	          failed: 0,
	          skipped: 0,
	          notRun: 0,
	        },
	        claimed: true,
	      })
      expect(restarted).toEqual([{ runId: '2026-05-19T0841-7cvh', sessionId: 'sess-restart' }])
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run returns candidates for an ambiguous run suffix', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-ambiguous-')))
    const featuresDir = path.join(projectRoot, 'features')
    const { app, runStore } = await createMcpHarness({ logsDir, projectRoot, featuresDir })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: {} },
      )
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))

      for (const runId of ['2026-05-19T0841-7cvh', '2026-05-19T0941-17cvh']) {
        runStore.bootstrap({
          runId,
          feature: 'broken_todo_api',
          env: 'local',
          startedAt: '2026-05-19T08:41:00.000Z',
          status: 'failed',
          healCycles: 1,
          services: [],
        })
      }

      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          run_ref: '7cvh',
          claim_heal: true,
          session_id: 'sess-ambiguous',
          client_kind: 'claude-desktop',
        },
      })

      const body = JSON.parse((result.content?.[0] as { text: string }).text)
      expect(body).toMatchObject({
        type: 'ambiguous_run_ref',
        run_ref: '7cvh',
      })
      expect(body.candidates.map((entry: { runId: string }) => entry.runId).sort()).toEqual([
        '2026-05-19T0841-7cvh',
        '2026-05-19T0941-17cvh',
      ])
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run starts a new run when no matching run is healing and no run ref is provided', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-new-')))
    const featuresDir = path.join(projectRoot, 'features')
    const starts: string[] = []
    const { app } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir,
      startRun: async (feature) => {
        starts.push(feature)
        return { runId: 'fresh-run' }
      },
    })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: {} },
      )
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))

      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-new',
          client_kind: 'claude-desktop',
        },
      })

      expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
        runId: 'fresh-run',
        reused: false,
        claimed: true,
      })
      expect(starts).toEqual(['broken_todo_api'])
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })
})
