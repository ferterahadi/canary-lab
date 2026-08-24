import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import path from 'path'

import { createServer } from '../server'

import type { PtyFactory } from '../features/runs/logic/runtime/pty-spawner'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decode } from '@toon-format/toon'

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

const uniqueSorted = (values: string[]): string[] => Array.from(new Set(values)).sort()

const REPAIR_TOOLS = uniqueSorted([
  'abort_run',
  'boot_services',
  'cancel_heal',
  'get_failure_detail',
  'get_heal_context',
  'get_run',
  'get_run_snapshot',
  'handoff_heal',
  'heartbeat',
  'list_features',
  'list_runs',
  'pause_run',
  'signal_run',
  'start_run',
  'wait_for_heal_task',
])

const VERIFY_TOOLS = uniqueSorted([
  'abort_run',
  'boot_services',
  'create_verification_config',
  'execute_verification',
  'get_run',
  'get_verification_config',
  'get_verification_result',
  'list_features',
  'list_runs',
  'list_verification_configs',
  'update_verification_config',
])

const AUTHOR_TOOLS = uniqueSorted([
  'apply_external_draft',
  'capture_feature_env_files',
  'checkout_feature_repo_branch',
  'create_feature',
  'delete_feature',
  'get_feature_coverage',
  'get_feature_envset_summary',
  'get_feature_repo_status',
  'get_run',
  'get_run_snapshot',
  'list_feature_docs',
  'list_features',
  'list_runs',
  'start_external_draft',
  'update_external_draft_stage',
  'write_envset',
])

const COVERAGE_TOOLS = uniqueSorted([
  'clear_prd_summary',
  'delete_feature_doc',
  'get_feature_coverage',
  'list_feature_docs',
  'list_features',
  'start_external_coverage',
  'start_external_summary',
  'submit_external_coverage',
  'submit_external_summary',
  'write_feature_doc',
])

const EXPORT_TOOLS = uniqueSorted([
  'delete_evaluation_export',
  'download_evaluation_export',
  'get_evaluation_export',
  'get_run',
  'list_evaluation_exports',
  'list_features',
  'list_runs',
  'start_external_evaluation_export',
  'submit_external_evaluation_export',
])

const FLIGHT_TOOLS = uniqueSorted([
  'abort_flight',
  'get_flight',
  // The skills' bootstrap liveness probe; see FLIGHT_TOOLS in tool-profiles.ts.
  'list_features',
  'pause_flight',
  'respond_flight_checkpoint',
  'start_flight',
  'stop_flight_agent',
  'write_feature_doc',
  // The portify hand-off trio — an external flight's portify stage parks for the
  // client, so the flight profile must be able to answer it. NOT the standalone
  // start/save/cancel/remove/list tools: those stay portify-only.
  'submit_external_portify',
  'revise_external_portify',
  'get_portify',
  // The run/heal hand-off loop, same rule.
  'claim_heal',
  'wait_for_heal_task',
  'signal_run',
])

const PORTIFY_TOOLS = uniqueSorted([
  'list_features',
  'list_runs',
  'start_external_portify',
  'submit_external_portify',
  'revise_external_portify',
  'get_portify',
  'save_portify',
  'cancel_portify',
  'remove_portification',
  'list_portify_status',
])

const FULL_ONLY_TOOLS = [
  'abort_run',
  'boot_services',
  'cancel_heal',
  'claim_heal',
  'create_verification_config',
  'execute_verification',
  'get_failure_detail',
  'get_heal_context',
  'get_run',
  'get_run_actions',
  'get_run_snapshot',
  'get_verification_config',
  'get_verification_result',
  'handoff_heal',
  'heartbeat',
  'list_features',
  'list_runs',
  'list_verification_configs',
  'pause_run',
  'release_heal',
  'signal_run',
  'start_run',
  'update_verification_config',
  'wait_for_heal_task',
]

// lifecycle = everything except portify; full = lifecycle + portify.
// Mirrors the composition in tools.ts exactly — REPAIR/VERIFY included. They were
// omitted here and it happened to hold only because every repair/verify tool also
// appears in another array; the first repair-only tool would have broken the count
// with no hint as to why.
const LIFECYCLE_TOOLS = uniqueSorted([
  ...REPAIR_TOOLS,
  ...VERIFY_TOOLS,
  ...AUTHOR_TOOLS,
  ...COVERAGE_TOOLS,
  ...EXPORT_TOOLS,
  ...FLIGHT_TOOLS,
  ...FULL_ONLY_TOOLS,
])

const FULL_TOOLS = uniqueSorted([...LIFECYCLE_TOOLS, ...PORTIFY_TOOLS])

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

  it('exposes /mcp/health with profile-specific tool counts', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    try {
      const res = await app.inject({ method: 'GET', url: '/mcp/health' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { ok: boolean; server: { name: string }; toolCount: number; profile: string; tools: string[]; clientKind: string }
      expect(body.ok).toBe(true)
      expect(body.server.name).toBe('canary-lab')
      // A bare health probe has no handshake to brand itself from, so an
      // absent client_kind still reports 'other'; an explicit one echoes back.
      expect(body.clientKind).toBe('other')
      const branded = await app.inject({ method: 'GET', url: '/mcp/health?client_kind=codex' })
      expect(branded.statusCode).toBe(200)
      expect((branded.json() as { clientKind: string }).clientKind).toBe('codex')
      // No-param default is `lifecycle` (everyday surface, no portify).
      expect(body.profile).toBe('lifecycle')
      expect(body.toolCount).toBe(LIFECYCLE_TOOLS.length)
      expect([...body.tools].sort()).toEqual(LIFECYCLE_TOOLS)

      const full = await app.inject({ method: 'GET', url: '/mcp/health?profile=full' })
      expect(full.statusCode).toBe(200)
      expect((full.json() as { profile: string; toolCount: number })).toMatchObject({
        profile: 'full',
        toolCount: FULL_TOOLS.length,
      })

      const verify = await app.inject({ method: 'GET', url: '/mcp/health?profile=verify' })
      expect(verify.statusCode).toBe(200)
      expect((verify.json() as { profile: string; toolCount: number })).toMatchObject({
        profile: 'verify',
        toolCount: VERIFY_TOOLS.length,
      })

      const author = await app.inject({ method: 'GET', url: '/mcp/health?profile=author' })
      expect(author.statusCode).toBe(200)
      expect((author.json() as { profile: string; toolCount: number })).toMatchObject({
        profile: 'author',
        toolCount: AUTHOR_TOOLS.length,
      })

      const lifecycle = await app.inject({ method: 'GET', url: '/mcp/health?profile=lifecycle' })
      expect(lifecycle.statusCode).toBe(200)
      expect((lifecycle.json() as { profile: string; tools: string[] })).toMatchObject({
        profile: 'lifecycle',
      })
      expect([...(lifecycle.json() as { tools: string[] }).tools].sort()).toEqual(LIFECYCLE_TOOLS)
      // lifecycle is full minus portify — no portify tool leaks in.
      expect((lifecycle.json() as { tools: string[] }).tools).not.toContain('start_portify')

      const portify = await app.inject({ method: 'GET', url: '/mcp/health?profile=portify' })
      expect(portify.statusCode).toBe(200)
      expect([...(portify.json() as { tools: string[] }).tools].sort()).toEqual(PORTIFY_TOOLS)

      const coverage = await app.inject({ method: 'GET', url: '/mcp/health?profile=coverage' })
      expect(coverage.statusCode).toBe(200)
      expect([...(coverage.json() as { tools: string[] }).tools].sort()).toEqual(COVERAGE_TOOLS)

      const exportProfile = await app.inject({ method: 'GET', url: '/mcp/health?profile=export' })
      expect(exportProfile.statusCode).toBe(200)
      expect([...(exportProfile.json() as { tools: string[] }).tools].sort()).toEqual(EXPORT_TOOLS)

      const flight = await app.inject({ method: 'GET', url: '/mcp/health?profile=flight' })
      expect(flight.statusCode).toBe(200)
      expect([...(flight.json() as { tools: string[] }).tools].sort()).toEqual(FLIGHT_TOOLS)

      // The repartition must not change what lifecycle/full expose: the new
      // leaf profiles are carve-outs of the old author array, so lifecycle
      // stays a superset of every non-portify leaf and full adds portify.
      const lifecycleSet = new Set(LIFECYCLE_TOOLS)
      for (const tool of [...AUTHOR_TOOLS, ...COVERAGE_TOOLS, ...EXPORT_TOOLS, ...FLIGHT_TOOLS]) {
        expect(lifecycleSet.has(tool)).toBe(true)
      }
      const fullSet = new Set(FULL_TOOLS)
      for (const tool of [...LIFECYCLE_TOOLS, ...PORTIFY_TOOLS]) {
        expect(fullSet.has(tool)).toBe(true)
      }
    } finally {
      await app.close()
    }
  })

  it('rejects invalid MCP profiles before creating sessions', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    try {
      const health = await app.inject({ method: 'GET', url: '/mcp/health?profile=nope' })
      expect(health.statusCode).toBe(400)
      expect(health.json()).toMatchObject({ error: 'invalid MCP profile: nope' })

      const init = await app.inject({
        method: 'POST',
        url: '/mcp?profile=nope',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'profile-probe', version: '0.0.1' },
          },
        },
      })
      expect(init.statusCode).toBe(400)
      expect(init.json()).toMatchObject({
        jsonrpc: '2.0',
        error: { message: 'invalid MCP profile: nope' },
      })
    } finally {
      await app.close()
    }
  })

  it('answers tools/list with the default lifecycle profile and tools/call over the streamable HTTP transport', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address)

      const tools = await client.listTools()
      const names = tools.tools.map((t) => t.name).sort()
      expect(names).toEqual(LIFECYCLE_TOOLS)

      // A new scaffold ships the two Getting Started suites: storefront for the
      // core Run demo and workflow-workbench for the smaller workflow demos.
      const result = await client.callTool({ name: 'list_features', arguments: {} })
      const text = toolText(result)
      const features = decode(text) as Array<{ name: string }>
      expect(features.map((f) => f.name)).toEqual(['storefront-journey', 'workflow-workbench'])
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('tools/call list_portify_status returns each feature with a portified flag + summary', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      // list_portify_status lives in the portify surface, not the lifecycle
      // default — connect with the full profile to exercise it.
      client = await connectClient(address, '/mcp?profile=full')

      const result = await client.callTool({ name: 'list_portify_status', arguments: {} })
      const text = toolText(result)
      const parsed = JSON.parse(text) as {
        features: Array<{ feature: string; portified: boolean; injectability: string }>
        summary: { total: number; portified: number; notPortified: number; concurrencyReady: number; needsPortify: number }
      }
      // Storefront is concurrency-ready as shipped. The deliberately small
      // workflow workbench keeps a fixed port so Portify has real work to show.
      expect(parsed.features.map((f) => f.feature)).toEqual(['storefront-journey', 'workflow-workbench'])
      expect(parsed.features[0]!.portified).toBe(false)
      expect(parsed.features[0]!.injectability).toBe('declared')
      expect(parsed.features[1]!.portified).toBe(false)
      expect(parsed.features[1]!.injectability).toBe('none')
      for (const f of parsed.features) expect(typeof f.portified).toBe('boolean')
      expect(parsed.summary).toEqual({ total: 2, portified: 0, notPortified: 2, concurrencyReady: 1, needsPortify: 1 })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('answers tools/list with the full profile', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=full')

      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name).sort()).toEqual(FULL_TOOLS)
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('answers tools/list with the verify profile', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=verify')

      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name).sort()).toEqual(VERIFY_TOOLS)
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('answers tools/list with the author profile', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=author')

      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name).sort()).toEqual(AUTHOR_TOOLS)
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })
})
