import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
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

  it('wait_for_heal_task reports needs_heal, terminal states, and still_waiting', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-wait-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=full')

      runStore.bootstrap({
        runId: 'wait-needs-heal',
        feature: 'demo_catalog',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
      })
      fs.writeFileSync(path.join(runDirFor(logsDir, 'wait-needs-heal'), 'heal-index.md'), '# Heal Index\n')
      await client.callTool({
        name: 'claim_heal',
        arguments: {
          runId: 'wait-needs-heal',
          session_id: 'sess-1',
          client_kind: 'codex',
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
      const needsHealBody = JSON.parse(toolText(needsHeal))
      expect(needsHealBody).toMatchObject({
        type: 'needs_heal',
        runId: 'wait-needs-heal',
        cycle: 1,
      })
      expect(needsHealBody.context.healPrompt.startHere[0]).toMatchObject({
        id: 'heal-index',
        field: 'healIndexMarkdown',
      })
      expect(needsHealBody.context.nextSteps?.length).toBeGreaterThan(0)

      // Repeat cycle (activeCycle 2): the static procedure + map are dropped;
      // the context carries only the changed failure packet plus a breadcrumb.
      runStore.recordLifecycleEvent('wait-needs-heal', {
        phase: 'waiting-for-signal',
        headline: 'Waiting for heal signal',
        updatedAt: '2026-05-08T00:00:02.000Z',
        activeCycle: 2,
      })
      const repeatHeal = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-needs-heal', session_id: 'sess-1', timeout_ms: 1000 },
      })
      const repeatBody = JSON.parse(toolText(repeatHeal))
      expect(repeatBody).toMatchObject({ type: 'needs_heal', cycle: 2 })
      expect(repeatBody.context).not.toHaveProperty('healPrompt')
      expect(repeatBody.context).not.toHaveProperty('nextSteps')
      expect(repeatBody.context.guidance).toContain('get_heal_context')
      // get_heal_context still re-fetches the full map on demand.
      const refetch = await client.callTool({
        name: 'get_heal_context',
        arguments: { runId: 'wait-needs-heal', session_id: 'sess-1' },
      })
      const refetchBody = JSON.parse(toolText(refetch))
      expect(refetchBody.healPrompt).toBeDefined()
      expect(refetchBody.nextSteps?.length).toBeGreaterThan(0)

      runStore.bootstrap({
        runId: 'wait-passed',
        feature: 'demo_catalog',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'passed',
        healCycles: 0,
        services: [],
      })
      const passed = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-passed', session_id: 'sess-1', timeout_ms: 1000 },
      })
      expect(JSON.parse(toolText(passed))).toMatchObject({
        type: 'passed',
        runId: 'wait-passed',
      })

      runStore.bootstrap({
        runId: 'wait-failed',
        feature: 'demo_catalog',
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
      const failedBody = JSON.parse(toolText(failed))
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
        feature: 'demo_catalog',
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
          client_kind: 'codex',
        },
      })
      const stillWaiting = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-timeout', session_id: 'sess-timeout', timeout_ms: 10 },
      })
      const stillWaitingBody = JSON.parse(toolText(stillWaiting))
      expect(stillWaitingBody).toMatchObject({
        type: 'still_waiting',
        runId: 'wait-timeout',
        status: 'running',
        nextSteps: ['wait_for_heal_task'],
      })
      // Not terminal, and tells the agent to loop.
      expect(typeof stillWaitingBody.cursor).toBe('string')
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('wait_for_heal_task claims an unclaimed external run with the MCP client kind', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-wait-claim-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=full&client_kind=claude')

      runStore.bootstrap({
        runId: 'wait-claim',
        feature: 'demo_catalog',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
      })
      fs.writeFileSync(path.join(runDirFor(logsDir, 'wait-claim'), 'heal-index.md'), '# Heal Index\n')
      runStore.recordLifecycleEvent('wait-claim', {
        phase: 'waiting-for-signal',
        headline: 'Waiting for heal signal',
        updatedAt: '2026-05-08T00:00:01.000Z',
        activeCycle: 1,
      })

      const result = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-claim', session_id: 'sess-claude', timeout_ms: 1000 },
      })

      const body = JSON.parse(toolText(result))
      expect(body).toMatchObject({
        type: 'needs_heal',
        runId: 'wait-claim',
        context: {
          runId: 'wait-claim',
          healIndex: {
            path: expect.stringContaining('heal-index.md'),
          },
        },
      })
      expect(body.context.healIndex).not.toHaveProperty('markdown')
      expect(JSON.stringify(body.context)).not.toContain('# Heal Index')
      expect(body.context).not.toHaveProperty('summary')
      expect(body.context).not.toHaveProperty('healIndexMarkdown')
      expect(runStore.get('wait-claim')?.manifest.externalHealSession).toMatchObject({
        sessionId: 'sess-claude',
        clientKind: 'claude',
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })
})
