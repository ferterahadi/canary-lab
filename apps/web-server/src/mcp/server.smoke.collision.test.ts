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

  it('start_run asks for a collision choice when a run is already using the same app', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-project-')))
    const projectRoot = path.join(workspace, 'project')
    fs.cpSync(path.join(repoRoot, 'templates', 'project'), projectRoot, { recursive: true })
    fs.cpSync(
      path.join(repoRoot, 'templates', 'project', 'features', 'storefront-journey'),
      path.join(projectRoot, 'features', 'storefront-journey'),
      { recursive: true },
    )
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

      // A run already occupying the storefront repo (running, not healing,
      // so the route's heal-reuse path doesn't short-circuit).
      runStore.bootstrap({
        runId: 'busy-run',
        feature: 'storefront-journey',
        env: 'local',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'running',
        healCycles: 0,
        services: [],
        // The feature's repo, NOT its feature dir. Collision is an exact
        // resolved path intersection, so a feature-dir path here would silently
        // never collide and the test would pass for the wrong reason.
        repoPaths: [path.join(projectRoot, 'demo-app')],
      })

      // A fresh same-app start detects the collision and asks how to resolve it
      // instead of blindly starting (or the old active_heal_blocks_start).
      const collision = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'storefront-journey',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-block',
          client_kind: 'claude',
        },
      })
      expect(JSON.parse(toolText(collision))).toMatchObject({
        type: 'repo_collision_requires_choice',
        conflictingRunId: 'busy-run',
        options: ['worktree', 'queue'],
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run prefers an existing run that is waiting for heal over a newer running run', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
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
        feature: 'demo_catalog',
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
        feature: 'demo_catalog',
        env: 'local',
        startedAt: '2026-05-08T00:01:00.000Z',
        status: 'running',
        healCycles: 0,
        services: [],
      })

      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'demo_catalog',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-heal-first',
          client_kind: 'claude',
        },
      })

      expect(JSON.parse(toolText(result))).toMatchObject({
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
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
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
        feature: 'demo_catalog',
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
          feature: 'demo_catalog',
          env: 'local',
          run_ref: '7cvh',
          claim_heal: true,
          session_id: 'sess-restart',
          client_kind: 'claude',
        },
      })

	      expect(JSON.parse(toolText(result))).toMatchObject({
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
      const restartBody = JSON.parse(toolText(result)) as { nextSteps?: string[] }
      expect(restartBody.nextSteps).toContain('wait_for_heal_task')
      expect(restarted).toEqual([{ runId: '2026-05-19T0841-7cvh', sessionId: 'sess-restart' }])
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run reports a held boot session instead of claiming heal', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-boot-')))
    const featuresDir = path.join(projectRoot, 'features')
    const { app, runStore } = await createMcpHarness({ logsDir, projectRoot, featuresDir })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=full')

      runStore.bootstrap({
        runId: '2026-06-04T1525-6qdm',
        feature: 'demo_catalog',
        env: 'local',
        startedAt: '2026-06-04T15:25:00.000Z',
        status: 'running',
        executionType: 'boot',
        healCycles: 0,
        services: [],
        healMode: 'external',
      })

      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'demo_catalog',
          env: 'local',
          run_ref: '6qdm',
          claim_heal: true,
          session_id: 'sess-boot',
          client_kind: 'claude',
        },
      })
      const body = JSON.parse(toolText(result))
      expect(body).toMatchObject({
        type: 'boot_session',
        executionType: 'boot',
        runId: '2026-06-04T1525-6qdm',
        reused: true,
        claimed: false,
        status: 'running',
      })
      // Boot sessions must not steer the agent into the heal wait loop.
      expect(body.nextSteps ?? []).not.toContain('wait_for_heal_task')
      expect(body.claim).toBeUndefined()
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('wait_for_heal_task returns boot_session immediately for a held boot run', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-wait-boot-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=full')

      runStore.bootstrap({
        runId: 'wait-boot',
        feature: 'demo_catalog',
        startedAt: '2026-06-04T15:25:00.000Z',
        status: 'running',
        executionType: 'boot',
        healCycles: 0,
        services: [],
        healMode: 'external',
      })

      // No claim_heal first — a boot run short-circuits before requiring a claim,
      // and with a generous timeout this must still return without blocking.
      const result = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-boot', session_id: 'sess-boot', timeout_ms: 600000 },
      })
      expect(JSON.parse(toolText(result))).toMatchObject({
        type: 'boot_session',
        runId: 'wait-boot',
        executionType: 'boot',
        status: 'running',
        claimed: false,
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })
})
