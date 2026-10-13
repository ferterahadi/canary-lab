import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'path'
import fs from 'fs'
import { createServer } from '../server'
import type { PtyFactory } from '../features/runs/logic/runtime/pty-spawner'
import type { ElicitResult } from '@modelcontextprotocol/client'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { connectSmokeClient, createMcpHarness, smokeToolText } from './__fixtures__/smoke-harness'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-mcp-demo-busy-')

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

  it('preserves the typed Getting Started owner when start_run is blocked', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = tempDir()
    const { app } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir: path.join(projectRoot, 'features'),
      startRun: async () => ({
        kind: 'getting-started-busy',
        active: {
          sessionId: 'gs-flight', workflow: 'flight', owner: 'internal',
          target: { kind: 'flight', id: 'fl-live' },
        },
        message: 'Full Flight is already running.',
      }),
    })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectSmokeClient(address, '/mcp?profile=lifecycle')
      const result = await client.callTool({
        name: 'start_run',
        arguments: { feature: 'storefront-journey', claim_heal: true, session_id: 'external' },
      })
      expect(JSON.parse(smokeToolText(result))).toMatchObject({
        type: 'getting_started_busy',
        active: { sessionId: 'gs-flight', owner: 'internal', target: { id: 'fl-live' } },
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('preserves the typed Getting Started owner when start_flight is blocked', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = tempDir('cl-mcp-flight-demo-busy-')
    const { app } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir: path.join(projectRoot, 'features'),
      flightsRequest: async () => ({
        statusCode: 409,
        body: {
          type: 'getting_started_busy',
          error: 'Run and Heal is already running.',
          active: {
            sessionId: 'gs-run', workflow: 'run', owner: 'external',
            target: { kind: 'run', id: 'run-live' },
          },
        },
      }),
    })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectSmokeClient(address, '/mcp?profile=lifecycle')
      const result = await client.callTool({
        name: 'start_flight',
        arguments: { repoPaths: [path.join(projectRoot, 'flight-app')], description: 'lending' },
      })
      expect(JSON.parse(smokeToolText(result))).toMatchObject({
        type: 'getting_started_busy',
        active: { sessionId: 'gs-run', owner: 'external', target: { id: 'run-live' } },
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run asks about stale coverage before asking how to resolve a repo collision', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
    const workspace = tempDir('cl-mcp-start-project-')
    const projectRoot = path.join(workspace, 'project')
    fs.cpSync(path.join(repoRoot, 'templates', 'project'), projectRoot, { recursive: true })
    fs.cpSync(
      path.join(repoRoot, 'templates', 'project', 'features', 'storefront-journey'),
      path.join(projectRoot, 'features', 'storefront-journey'),
      { recursive: true },
    )
    const logsDir = tempDir('cl-mcp-start-block-')
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const answer = vi.fn(async ({ params }: { params: Record<string, unknown> }): Promise<ElicitResult> => {
        const schema = params.requestedSchema as { properties?: Record<string, unknown> } | undefined
        return schema?.properties?.choice
          ? { action: 'accept' as const, content: { choice: 'Run now with stale coverage' } }
          : { action: 'accept' as const, content: { isolation: 'queue' } }
      })
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: { elicitation: { form: {} } } },
      )
      client.setRequestHandler('elicitation/create', answer)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=lifecycle', address)))

      // Another feature already occupies the same app repo. Same-feature
      // starts continue the existing run before reaching collision handling.
      runStore.bootstrap({
        runId: 'busy-run',
        feature: 'other-storefront-suite',
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

      // The suite's copied mapping is stale, so the fresh start asks whether to
      // update it before reaching the independent repository collision choice.
      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'storefront-journey',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-block',
          client_kind: 'claude',
        },
      })
      expect(JSON.parse(smokeToolText(result))).toMatchObject({
        queued: true,
        queueReason: 'repo-collision',
        coverageStale: true,
      })
      expect(answer).toHaveBeenCalledTimes(2)
      expect(answer.mock.calls[0]?.[0].params).toMatchObject({ message: expect.stringContaining('The coverage report may not match the current tests') })
      expect(answer.mock.calls[1]?.[0].params).toMatchObject({ message: expect.stringContaining('other-storefront-suite') })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run prefers an existing run that is waiting for heal over a newer running run', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = tempDir('cl-mcp-start-heal-first-')
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: {} },
      )
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=lifecycle', address)))

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

      expect(JSON.parse(smokeToolText(result))).toMatchObject({
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
    const logsDir = tempDir('cl-mcp-start-ref-')
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
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=lifecycle', address)))

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

	      expect(JSON.parse(smokeToolText(result))).toMatchObject({
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
      const restartBody = JSON.parse(smokeToolText(result)) as { nextSteps?: string[] }
      expect(restartBody.nextSteps).toContain('wait_for_heal_task')
      expect(restarted).toEqual([{ runId: '2026-05-19T0841-7cvh', sessionId: 'sess-restart' }])
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('refuses a terminal run_ref when its suite attempt receipt was claimed', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = tempDir('cl-mcp-spent-ref-')
    const restarted = vi.fn()
    const { app, runStore } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir: path.join(projectRoot, 'features'),
      restartExternalRun: restarted,
    })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectSmokeClient(address, '/mcp?profile=lifecycle')
      const runId = '2026-05-19T0841-spent'
      const featureDir = path.join(logsDir, 'features', 'demo_catalog')
      fs.mkdirSync(featureDir, { recursive: true })
      fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'),
        "module.exports = { config: { name: 'demo_catalog', singleAttempt: { receipt: 'runtime/effect-attempt/attempt.json' } } }\n")
      runStore.bootstrap({
        runId, feature: 'demo_catalog', env: 'local',
        featureDir,
        startedAt: '2026-05-19T08:41:00.000Z', status: 'failed',
        healCycles: 1, services: [], healMode: 'external',
      })
      const receipt = path.join(logsDir, 'runs', runId, 'runtime/effect-attempt/attempt.json')
      fs.mkdirSync(path.dirname(receipt), { recursive: true })
      fs.writeFileSync(receipt, '{}')

      const result = await client.callTool({
        name: 'start_run',
        arguments: { feature: 'demo_catalog', env: 'local', run_ref: 'spent', session_id: 'sess-restart' },
      })

      expect(JSON.parse(smokeToolText(result))).toMatchObject({ type: 'new_run_required', runId })
      expect(restarted).not.toHaveBeenCalled()
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run reports a held boot session instead of claiming heal', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = tempDir('cl-mcp-start-boot-')
    const featuresDir = path.join(projectRoot, 'features')
    const { app, runStore } = await createMcpHarness({ logsDir, projectRoot, featuresDir })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectSmokeClient(address, '/mcp?profile=full')

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
      const body = JSON.parse(smokeToolText(result))
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
    const logsDir = tempDir('cl-mcp-wait-boot-')
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectSmokeClient(address, '/mcp?profile=full')

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
      expect(JSON.parse(smokeToolText(result))).toMatchObject({
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
