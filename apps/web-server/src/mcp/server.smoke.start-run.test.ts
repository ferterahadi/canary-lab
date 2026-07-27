import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import Fastify from 'fastify'
import { createServer } from '../server'
import { registerMcpRoutes } from './server'
import { createRegistry, RunStore } from '../features/runs/logic/run-store'
import { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import type { PtyFactory } from '../features/runs/logic/runtime/pty-spawner'
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

async function createMcpHarness(opts: {
  logsDir: string
  projectRoot: string
  featuresDir: string
  startRun?: Parameters<typeof registerMcpRoutes>[1]['startRun']
  restartExternalRun?: Parameters<typeof registerMcpRoutes>[1]['restartExternalRun']
  startVerification?: Parameters<typeof registerMcpRoutes>[1]['startVerification']
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
    startRun: opts.startRun ?? (async () => ({ kind: 'started', runId: 'new-run' })),
    restartExternalRun: opts.restartExternalRun,
    startVerification: opts.startVerification,
  })
  return { app, runStore }
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

  it('start_run reuses a healing feature run instead of creating a duplicate', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
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
          client_kind: 'claude',
          conversation_name: 'resume existing run',
        },
      })
      const body = JSON.parse(toolText(result))
      expect(body).toMatchObject({
        runId: 'reuse-active',
        reused: true,
        status: 'healing',
        claimed: true,
      })
      expect(runStore.list({ feature: 'broken_todo_api' }).map((entry) => entry.runId)).toEqual(['reuse-active'])
      expect(runStore.get('reuse-active')?.manifest.externalHealSession).toMatchObject({
        sessionId: 'sess-reuse',
        clientKind: 'claude',
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run starts a fresh runner-PTY run as external-origin with claimable:false (denylist policy)', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-cli-fresh-')))
    const featuresDir = path.join(projectRoot, 'features')
    const calls: Array<Parameters<NonNullable<Parameters<typeof registerMcpRoutes>[1]['startRun']>>> = []
    const { app } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir,
      startRun: async (...args) => {
        calls.push(args)
        return { kind: 'started', runId: 'new-run' }
      },
    })
    let client: Client | null = null
    // Denylist policy: a runner-spawned PTY agent can't claim, but the run must
    // still be external-origin so it uses External-client heal, not the project
    // agent. (The file-wide default already blocks the *-pty kinds.)
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=full')
      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-pty',
          client_kind: 'claude-pty',
          conversation_name: 'pty fresh start',
        },
      })
      const body = JSON.parse(toolText(result))
      expect(body).toMatchObject({ runId: 'new-run', reused: false, claimed: false, claimSuppressed: true })
      expect(body.nextSteps ?? []).not.toContain('wait_for_heal_task')
      // The run is still external-origin (claimable:false) — it must NOT fall
      // back to the project Heal Agent.
      expect(calls).toHaveLength(1)
      expect(calls[0][2]).toEqual({
        kind: 'external',
        sessionId: 'sess-pty',
        clientKind: 'claude-pty',
        conversationName: 'pty fresh start',
        claimable: false,
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run starts a fresh interactive Claude run as claimable external origin', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-desktop-fresh-')))
    const featuresDir = path.join(projectRoot, 'features')
    const calls: Array<Parameters<NonNullable<Parameters<typeof registerMcpRoutes>[1]['startRun']>>> = []
    const { app } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir,
      startRun: async (...args) => {
        calls.push(args)
        return { kind: 'started', runId: 'new-run' }
      },
    })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=full')
      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-interactive',
          client_kind: 'claude',
        },
      })
      const body = JSON.parse(toolText(result))
      expect(body).toMatchObject({ runId: 'new-run', reused: false, claimed: true })
      expect(body.claimSuppressed).toBeUndefined()
      expect(calls).toHaveLength(1)
      expect(calls[0][2]).toEqual({
        kind: 'external',
        sessionId: 'sess-interactive',
        clientKind: 'claude',
        claimable: true,
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run restarts a failed run for a runner PTY agent as external-origin (claimable:false, not refused)', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-restart-cli-')))
    const featuresDir = path.join(projectRoot, 'features')
    const restartCalls: Array<Parameters<NonNullable<Parameters<typeof registerMcpRoutes>[1]['restartExternalRun']>>> = []
    const { app, runStore } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir,
      restartExternalRun: async (runId, healAgent, guidance) => {
        restartCalls.push([runId, healAgent, guidance])
        runStore.patchManifest(runId, { status: 'running' })
        return { runId }
      },
    })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=full')
      runStore.bootstrap({
        runId: '2026-05-19T0841-7cvh',
        feature: 'broken_todo_api',
        env: 'local',
        startedAt: '2026-05-19T08:41:00.000Z',
        status: 'failed',
        healCycles: 2,
        services: [],
      })
      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          run_ref: '7cvh',
          claim_heal: true,
          session_id: 'sess-restart-pty',
          client_kind: 'claude-pty',
        },
      })
      const body = JSON.parse(toolText(result))
      // Not refused (no claim_not_allowed): the run restarts into external mode.
      expect(body).toMatchObject({
        runId: '2026-05-19T0841-7cvh',
        restarted: true,
        claimed: false,
        claimSuppressed: true,
      })
      expect(body.type).toBeUndefined()
      expect(body.nextSteps ?? []).not.toContain('wait_for_heal_task')
      expect(restartCalls).toHaveLength(1)
      expect(restartCalls[0][1]).toEqual({
        kind: 'external',
        sessionId: 'sess-restart-pty',
        clientKind: 'claude-pty',
        claimable: false,
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run suppresses the heal claim for a runner PTY agent (denylist policy)', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-suppress-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=full')

      runStore.bootstrap({
        runId: 'suppress-active',
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
          session_id: 'sess-pty',
          client_kind: 'claude-pty',
          conversation_name: 'pty should not claim',
        },
      })
      const body = JSON.parse(toolText(result))
      expect(body).toMatchObject({
        runId: 'suppress-active',
        reused: true,
        claimed: false,
        claimSuppressed: true,
      })
      expect(typeof body.message).toBe('string')
      // The PTY agent must NOT be steered into the heal wait loop.
      expect(body.nextSteps ?? []).not.toContain('wait_for_heal_task')
      expect(body.claim).toBeNull()
      // The pre-existing external session (if any) is untouched — no PTY claim
      // was recorded.
      expect(runStore.get('suppress-active')?.manifest.externalHealSession).toBeUndefined()
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })
})
