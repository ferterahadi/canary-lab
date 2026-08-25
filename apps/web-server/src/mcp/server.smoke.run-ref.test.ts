import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import Fastify from 'fastify'
import { registerMcpRoutes } from './server'
import { createRegistry, RunStore } from '../features/runs/logic/run-store'
import { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

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

  it('start_run returns candidates for an ambiguous run suffix', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
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
          feature: 'demo_catalog',
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
          feature: 'demo_catalog',
          env: 'local',
          run_ref: '7cvh',
          claim_heal: true,
          session_id: 'sess-ambiguous',
          client_kind: 'claude',
        },
      })

      const body = JSON.parse(toolText(result))
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
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-new-')))
    const featuresDir = path.join(projectRoot, 'features')
    const starts: string[] = []
    const { app } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir,
      startRun: async (feature) => {
        starts.push(feature)
        return { kind: 'started', runId: 'fresh-run' }
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
          feature: 'demo_catalog',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-new',
          client_kind: 'claude',
        },
      })

      expect(JSON.parse(toolText(result))).toMatchObject({
        runId: 'fresh-run',
        reused: false,
        claimed: true,
      })
      expect(starts).toEqual(['demo_catalog'])
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('boot_services starts a boot-mode run with no heal agent', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-boot-')))
    const featuresDir = path.join(projectRoot, 'features')
    const calls: Array<{ feature: string; env?: string; healAgent: unknown; isolation?: string; executionType?: string }> = []
    const { app } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir,
      startRun: async (feature, env, healAgent, isolation, executionType) => {
        calls.push({ feature, env, healAgent, isolation, executionType })
        return { kind: 'started', runId: 'boot-run' }
      },
    })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = new Client({ name: 'canary-lab-smoke', version: '0.0.1' }, { capabilities: {} })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))

      const result = await client.callTool({
        name: 'boot_services',
        arguments: { feature: 'demo_inventory', env: 'local' },
      })

      expect(JSON.parse(toolText(result))).toMatchObject({
        runId: 'boot-run',
        booted: true,
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ feature: 'demo_inventory', env: 'local', executionType: 'boot' })
      // Boot sessions never heal — no external heal agent is attached.
      expect(calls[0].healAgent).toBeUndefined()
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })
})
