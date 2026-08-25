import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import { McpServer } from '@modelcontextprotocol/server'
import { createServer } from '../server'
import type { PtyFactory } from '../features/runs/logic/runtime/pty-spawner'
import {
  DEFAULT_CANARY_LAB_MCP_PROFILE,
  TOOLS_BY_PROFILE,
  registerCanaryLabTools,
  type CanaryLabMcpDeps,
} from './tools'

// What happens when a tool group registers a tool no profile array lists.
//
// `registerCanaryLabTools` throws on that, which is the invariant the
// tool-profiles ↔ smoke-test mirror rests on: a tool nobody assigned would
// otherwise register into whichever profile happened to be building, and the
// mismatch would only surface as a confusing tool-count diff. Proving it needs a
// group that misbehaves, so this suite mocks one — hence its own file, since
// `vi.mock` is per-file.
//
// The same throw is the only way to make `newSession` fail mid-request, so it
// doubles as the proof that the route answers a failed session build with a 500
// instead of leaving the client's connection hanging open.

// Off during boot: `registerMcpRoutes` counts tools for every profile up front,
// so a rogue registration at that point would fail createServer itself and never
// reach the request path this suite is about.
const rogue = vi.hoisted(() => ({
  mode: 'off' as 'off' | 'unassigned' | 'duplicate' | 'missing',
  name: 'unassigned_probe',
}))

vi.mock('./tool-groups/reads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool-groups/reads')>()
  return {
    registerReadTools: (ctx: Parameters<typeof actual.registerReadTools>[0]) => {
      if (rogue.mode === 'missing') {
        actual.registerReadTools({
          ...ctx,
          registerTool: ((name: string, config: unknown, handler: unknown) => {
            if (name !== 'list_features') {
              const register = ctx.registerTool as unknown as (name: string, config: unknown, handler: unknown) => void
              register(name, config, handler)
            }
          }) as typeof ctx.registerTool,
        })
      } else {
        actual.registerReadTools(ctx)
      }
      if (rogue.mode === 'unassigned') {
        ctx.registerTool(rogue.name, { description: 'a tool no profile claims' }, async () => ({ content: [] }))
      }
      if (rogue.mode === 'duplicate') {
        ctx.registerTool('list_features', { inputSchema: {} }, async () => ({ content: [] }))
      }
    },
  }
})

const inertPtyFactory: PtyFactory = () => ({
  pid: 0,
  onData: () => ({ dispose: () => { /* noop */ } }),
  onExit: () => ({ dispose: () => { /* noop */ } }),
  write: () => { /* noop */ },
  resize: () => { /* noop */ },
  kill: () => { /* noop */ },
})

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')

// Registration reads nothing off deps — the tools only touch them inside their
// handlers — so the assertions here are about which names got registered.
const inertDeps = {
  featuresDir: path.join(PROJECT_ROOT, 'features'),
  projectRoot: PROJECT_ROOT,
  store: { list: () => [], get: () => undefined },
  broker: { getSession: () => null },
  startRun: async () => ({ kind: 'started' as const, runId: 'run-1' }),
} as unknown as CanaryLabMcpDeps

describe('MCP tool registration guard', () => {
  it('registers the default profile when the caller names none', () => {
    const mcp = new McpServer({ name: 'canary-lab', version: '1.0.0' })
    registerCanaryLabTools(mcp, inertDeps)
    const registered = (mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
    expect(Object.keys(registered).sort()).toEqual([...TOOLS_BY_PROFILE[DEFAULT_CANARY_LAB_MCP_PROFILE]].sort())
  })

  it('refuses to register a tool no profile array claims', () => {
    rogue.mode = 'unassigned'
    try {
      const mcp = new McpServer({ name: 'canary-lab', version: '1.0.0' })
      expect(() => registerCanaryLabTools(mcp, inertDeps, { profile: 'repair' }))
        .toThrow(`MCP tool is not assigned to a profile: ${rogue.name}`)
    } finally {
      rogue.mode = 'off'
    }
  })

  it('refuses duplicate registrations and missing assigned tools', () => {
    const mcp = new McpServer({ name: 'canary-lab', version: '1.0.0' })
    try {
      rogue.mode = 'duplicate'
      expect(() => registerCanaryLabTools(mcp, inertDeps, { profile: 'repair' }))
        .toThrow('MCP tool is registered more than once: list_features')

      rogue.mode = 'missing'
      expect(() => registerCanaryLabTools(mcp, inertDeps, { profile: 'repair' }))
        .toThrow('MCP tools are assigned but not registered: list_features')
    } finally {
      rogue.mode = 'off'
    }
  })

  it('answers a 500 when building the session throws', async () => {
    const { app } = await createServer({ projectRoot: PROJECT_ROOT, ptyFactory: inertPtyFactory })
    try {
      // Boot first, then break registration: the failure has to happen while
      // handling the initialize request, not while mounting the route.
      rogue.mode = 'unassigned'
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'rogue-probe', version: '0.0.1' },
          },
        },
      })
      expect(res.statusCode).toBe(500)
      expect(res.json() as { error: string }).toEqual({
        error: `MCP tool is not assigned to a profile: ${rogue.name}`,
      })
      // The half-built session is not left in the map for the next request to
      // find — nothing was registered, so there is nothing to route to.
      rogue.mode = 'off'
      const probe = await app.inject({ method: 'GET', url: '/mcp/health' })
      expect((probe.json() as { activeSessions: number }).activeSessions).toBe(0)
    } finally {
      rogue.mode = 'off'
      await app.close()
    }
  })
})
