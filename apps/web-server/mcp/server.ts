import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { RunStore } from '../lib/run-store'
import type { ExternalHealBroker } from '../lib/external-heal-broker'
import {
  normalizeCanaryLabMcpProfile,
  registerCanaryLabTools,
  type CanaryLabMcpDeps,
  type CanaryLabMcpProfile,
} from './tools'
import type { ExternalHealClientKind } from '../lib/runtime/manifest'

// Singleton MCP server mounted on the existing Fastify instance at `/mcp`.
// Uses the streamable HTTP transport so Claude Desktop / Codex Desktop and
// other MCP clients (claude-cli, codex-cli, mcp-inspector, custom scripts)
// can connect over plain HTTP at localhost:7421/mcp.
//
// The implementation is intentionally thin: every tool is a wrapper around an
// existing REST endpoint or internal helper. The MCP server doesn't own
// state — RunStore + ExternalHealBroker do. Notifications + resources are a
// follow-up; v1 ships tools only.

export interface McpRouteDeps extends CanaryLabMcpDeps {
  store: RunStore
  broker: ExternalHealBroker
  featuresDir: string
  projectRoot: string
  /** Same startRun factory used by the runs route — lets MCP `start_run`
   *  reuse the production code path (envset apply, repo validation, etc.). */
  startRun: (
    feature: string,
    env?: string,
    healAgent?: {
      kind: 'external'
      sessionId: string
      clientKind: 'claude-cli' | 'claude-desktop' | 'codex-cli' | 'codex-desktop' | 'other'
      clientVersion?: string
      conversationName?: string
    },
  ) => Promise<{ runId: string }>
}

const SERVER_INFO = { name: 'canary-lab', version: '1.0.0', title: 'Canary Lab' }

export async function registerMcpRoutes(
  app: FastifyInstance,
  deps: McpRouteDeps,
): Promise<void> {
  // One McpServer + StreamableHTTPServerTransport pair per MCP session.
  // The transport sets an "initialized" flag on its first handshake and
  // rejects every later initialize with -32600 "Server already
  // initialized", so a singleton would cap us at one MCP client per
  // Fastify boot. Keyed by the session id the transport mints on init.
  const transports = new Map<string, StreamableHTTPServerTransport>()

  // Tool counts are static per profile — register tools on detached McpServer
  // instances (never connected to a transport) so /mcp/health can answer
  // without requiring an active MCP session.
  const toolCounts = {
    repair: countToolsForProfile(deps, 'repair'),
    verify: countToolsForProfile(deps, 'verify'),
    author: countToolsForProfile(deps, 'author'),
    full: countToolsForProfile(deps, 'full'),
  } satisfies Record<CanaryLabMcpProfile, number>

  const newSession = async (
    profile: CanaryLabMcpProfile,
    defaultClientKind: ExternalHealClientKind,
  ): Promise<StreamableHTTPServerTransport> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports.set(id, transport) },
      onsessionclosed: (id) => { transports.delete(id) },
    })
    transport.onclose = () => {
      const id = transport.sessionId
      if (id) transports.delete(id)
    }
    const mcp = new McpServer(SERVER_INFO)
    registerCanaryLabTools(mcp, deps, { profile, defaultClientKind })
    await mcp.connect(transport)
    return transport
  }

  // Fastify pre-parses the JSON body, so we hand it to handleRequest as the
  // pre-parsed `parsedBody` argument. The transport handles GET (SSE stream),
  // POST (client→server message), and DELETE (close session).
  const handle = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const header = req.headers['mcp-session-id']
      const sessionId = Array.isArray(header) ? header[0] : header

      let transport: StreamableHTTPServerTransport
      if (sessionId) {
        const existing = transports.get(sessionId)
        if (!existing) {
          reply.code(404).send({
            jsonrpc: '2.0',
            error: { code: -32001, message: `Unknown MCP session: ${sessionId}` },
            id: null,
          })
          return
        }
        transport = existing
      } else if (req.method === 'POST' && isInitializeRequest(req.body)) {
        const context = contextFromUrl(req.url)
        if (!context.ok) {
          reply.code(400).send({
            jsonrpc: '2.0',
            error: { code: -32602, message: context.error },
            id: null,
          })
          return
        }
        transport = await newSession(context.profile, context.clientKind)
      } else {
        reply.code(400).send({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: 'Bad Request: missing mcp-session-id header (POST initialize is the only request that may omit it)',
          },
          id: null,
        })
        return
      }

      await transport.handleRequest(req.raw, reply.raw, req.body)
    } catch (err) {
      // The transport writes directly to res.raw, so if it threw before
      // sending, our Fastify layer needs to close the reply cleanly.
      app.log.error({ err }, 'MCP transport.handleRequest threw')
      if (!reply.sent) {
        reply.code(500).send({ error: (err as Error).message })
      }
    }
  }

  app.post('/mcp', handle)
  app.get('/mcp', handle)
  app.delete('/mcp', handle)

  // Lightweight health endpoint so smoke tests can confirm the MCP route is
  // mounted without speaking the protocol.
  app.get('/mcp/health', async (req, reply) => {
    const context = contextFromUrl(req.url)
    if (!context.ok) {
      reply.code(400)
      return { error: context.error }
    }
    return {
      ok: true,
      server: SERVER_INFO,
      profile: context.profile,
      clientKind: context.clientKind,
      toolCount: toolCounts[context.profile],
      activeSessions: transports.size,
      projectRoot: deps.projectRoot,
    }
  })
}

function countToolsForProfile(deps: McpRouteDeps, profile: CanaryLabMcpProfile): number {
  const probe = new McpServer(SERVER_INFO)
  registerCanaryLabTools(probe, deps, { profile })
  return countTools(probe)
}

function contextFromUrl(url: string):
  | { ok: true; profile: CanaryLabMcpProfile; clientKind: ExternalHealClientKind }
  | { ok: false; error: string } {
  const params = new URL(url, 'http://localhost').searchParams
  const rawProfile = params.get('profile') ?? undefined
  const profile = normalizeCanaryLabMcpProfile(rawProfile)
  if (!profile) return { ok: false, error: `invalid MCP profile: ${rawProfile}` }
  const rawClientKind = params.get('client_kind') ?? 'other'
  if (!isExternalHealClientKind(rawClientKind)) {
    return { ok: false, error: `invalid MCP client_kind: ${rawClientKind}` }
  }
  return { ok: true, profile, clientKind: rawClientKind }
}

function countTools(mcp: McpServer): number {
  // The McpServer keeps registered tools on a private field; the public
  // surface doesn't expose a count. Best-effort introspection — we cast to
  // any only here so the rest of the file stays typed.
  const tools = (mcp as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools
  return tools ? Object.keys(tools).length : 0
}

function isExternalHealClientKind(value: string): value is ExternalHealClientKind {
  return value === 'claude-cli' ||
    value === 'claude-desktop' ||
    value === 'codex-cli' ||
    value === 'codex-desktop' ||
    value === 'other'
}
