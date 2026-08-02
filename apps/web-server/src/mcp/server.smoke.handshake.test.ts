import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import Fastify from 'fastify'
import { createServer } from '../server'
import type { PtyFactory } from '../features/runs/logic/runtime/pty-spawner'
import { runDirFor } from '../features/runs/logic/runtime/run-paths'
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

// The SDK's callTool() return type is a union of the normal tool-result shape
// and a legacy/task shape that only carries an index signature; TS collapses
// `.content` across that union to `unknown`, and `unknown?.[0]` then reports
// as unindexable `{}` at every call site. Centralize the one cast here instead
// of repeating it ~40 times.
type ToolCallResult = Awaited<ReturnType<Client['callTool']>>

function toolText(result: ToolCallResult): string {
  const content = (result as { content?: unknown }).content
  const first = Array.isArray(content) ? (content[0] as { type?: string; text?: string } | undefined) : undefined
  return first?.text ?? ''
}

async function connectClient(address: string, pathAndQuery = '/mcp'): Promise<Client> {
  const client = new Client(
    { name: 'canary-lab-smoke', version: '0.0.1' },
    { capabilities: {} },
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(pathAndQuery, address)))
  return client
}

describe('MCP HTTP server (smoke)', () => {
  // These E2E tests exercise claim flows across interactive client kinds
  // (codex, 'other' auto-claims), which the default denylist policy allows.
  // Pin the default block list explicitly so an ambient override can't leak in;
  // the policy itself is asserted by heal-claim-policy / broker / route tests,
  // and by the dedicated suppression tests below which start a runner PTY kind.
  const BLOCKED_PTY_KINDS = 'claude-pty,codex-pty'

  let prevClaimClients: string | undefined

  beforeAll(() => {
    prevClaimClients = process.env.CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS
    process.env.CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS = BLOCKED_PTY_KINDS
  })

  afterAll(() => {
    if (prevClaimClients === undefined) delete process.env.CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS
    else process.env.CANARY_LAB_HEAL_CLAIM_BLOCKED_CLIENTS = prevClaimClients
  })

  it('accepts back-to-back initialize handshakes from independent clients', async () => {
    // Regression for the singleton-transport bug: a single McpServer +
    // StreamableHTTPServerTransport pair flips an "initialized" flag on
    // first handshake and rejects every later initialize with -32600
    // "Server already initialized". That meant exactly one MCP client per
    // Fastify boot. The route must mint a fresh transport per session.
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
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
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
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

  it('get_heal_context returns compact context and get_run_snapshot returns the full fallback', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-context-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address)

      runStore.bootstrap({
        runId: 'context-map',
        feature: 'demo_catalog',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
        repoPaths: ['/repo/app'],
      })
      const runDir = runDirFor(logsDir, 'context-map')
      fs.writeFileSync(path.join(runDir, 'heal-index.md'), '# Heal Index\n')
      fs.writeFileSync(path.join(runDir, 'diagnosis-journal.md'), '# Journal\n')
      fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({
        complete: false,
        total: 3,
        passed: 1,
        passedNames: ['test-1'],
        knownTests: [
          { name: 'test-1' },
          { name: 'test-2' },
          { name: 'test-3' },
        ],
        failed: [
          {
            name: 'test-2',
            error: { message: 'boom' },
            location: 'e2e/example.spec.ts:10',
            logFiles: ['failed/test-2/svc-app.log'],
          },
        ],
      }))
      fs.mkdirSync(path.join(runDir, 'failed', 'test-case', 'trace-extract'), { recursive: true })
      fs.writeFileSync(path.join(runDir, 'failed', 'test-case', 'trace-extract', 'failure-summary.md'), '# Trace\n')

      const result = await client.callTool({
        name: 'get_heal_context',
        arguments: { runId: 'context-map', session_id: 'sess-context' },
      })
      const body = JSON.parse(toolText(result))

      expect(body).toMatchObject({
        runId: 'context-map',
        feature: 'demo_catalog',
        counts: {
          totalKnown: 3,
          passed: 1,
          failed: 1,
          skipped: 0,
          notRun: 1,
          statusLine: '1/3 passed, 1 failed, 1 not run',
        },
        healIndex: {
          path: path.join(runDir, 'heal-index.md'),
        },
        journal: {
          path: path.join(runDir, 'diagnosis-journal.md'),
        },
        failedTests: [
          {
            failureId: 'test-2',
            name: 'test-2',
            logFiles: ['failed/test-2/svc-app.log'],
          },
        ],
      })
      expect(body.healIndex).not.toHaveProperty('markdown')
      expect(body.journal).not.toHaveProperty('markdown')
      expect(JSON.stringify(body)).not.toContain('# Heal Index')
      expect(body).not.toHaveProperty('summary')
      expect(body).not.toHaveProperty('healIndexMarkdown')
      expect(body).not.toHaveProperty('journalMarkdown')
      expect(body.counts).not.toHaveProperty('notRunNames')
      expect(JSON.stringify(body)).not.toContain('test-3')
      expect(body.healPrompt).toMatchObject({
        source: 'canary-lab/heal-agent-map',
        mode: 'service',
        startHere: [
          {
            id: 'heal-index',
            field: 'healIndexMarkdown',
            path: path.join(runDir, 'heal-index.md'),
          },
        ],
        boundaries: {
          signalPolicy: {
            serviceOrRuntimeChange: 'restart',
            testOrConfigOnlyChange: 'rerun',
            mechanism: 'call signal_run; do not write signal files directly',
          },
        },
      })
      expect(body.healPrompt.resources.map((entry: { id: string }) => entry.id)).toEqual([
        'trace-extract',
        'journal',
      ])

      const snapshotResult = await client.callTool({
        name: 'get_run_snapshot',
        arguments: { runId: 'context-map' },
      })
      const snapshot = JSON.parse(toolText(snapshotResult))
      expect(snapshot).toMatchObject({
        runId: 'context-map',
        summary: {
          knownTests: [
            { name: 'test-1' },
            { name: 'test-2' },
            { name: 'test-3' },
          ],
        },
        counts: {
          notRunNames: ['test-3'],
          statusLine: '1/3 passed, 1 failed, 1 not run',
        },
        healIndex: { path: path.join(runDir, 'heal-index.md') },
        journal: { path: path.join(runDir, 'diagnosis-journal.md') },
        artifactsBase: '/api/runs/context-map/artifacts/',
      })
      // Verbose snapshot keeps the raw summary + full counts, but the heal-index/
      // journal markdown is now a PATH (like get_heal_context) — never inlined.
      expect(snapshot).not.toHaveProperty('healIndexMarkdown')
      expect(snapshot).not.toHaveProperty('journalMarkdown')
      expect(JSON.stringify(snapshot)).not.toContain('# Heal Index')
      expect(JSON.stringify(snapshot)).not.toContain('# Journal')
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('get_run omits raw arrays by default and inlines them with includeRaw, list_runs honors limit', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-getrun-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address)

      for (let i = 0; i < 3; i += 1) {
        runStore.bootstrap({
          runId: `run-${i}`,
          feature: 'demo_catalog',
          startedAt: `2026-05-0${i + 1}T00:00:00.000Z`,
          status: 'passed',
          healCycles: 0,
          services: [],
          healMode: 'external',
        })
      }

      // get_run: slim by default — raw arrays are absent, the omission is announced.
      const slim = JSON.parse(toolText(await client.callTool({
        name: 'get_run',
        arguments: { runId: 'run-1' },
      })))
      expect(slim).toMatchObject({ runId: 'run-1' })
      expect(slim).not.toHaveProperty('lifecycleEvents')
      expect(slim).not.toHaveProperty('playwrightArtifacts')
      expect(slim).not.toHaveProperty('playbackEvents')
      expect(slim.raw.omitted).toContain('lifecycleEvents')

      // includeRaw:true returns the full RunDetail (no `raw` envelope marker).
      const full = JSON.parse(toolText(await client.callTool({
        name: 'get_run',
        arguments: { runId: 'run-1', includeRaw: true },
      })))
      expect(full).toMatchObject({ runId: 'run-1' })
      expect(full).not.toHaveProperty('raw')

      // list_runs: newest-first, capped by limit. Returned as a TOON table —
      // a `[N]{col,...}:` header (runId is the first column) then one row each.
      const limitedText = toolText(await client.callTool({
        name: 'list_runs',
        arguments: { feature: 'demo_catalog', limit: 2 },
      }))
      const limitedLines = limitedText.trim().split('\n')
      expect(limitedLines[0]).toMatch(/^\[2\]\{runId,/)
      expect(limitedLines).toHaveLength(3) // header + 2 rows
      expect(limitedLines[1].trim().startsWith('run-2,')).toBe(true)
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })
})
