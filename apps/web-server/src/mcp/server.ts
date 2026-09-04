import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'crypto'
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node'
import { createMcpHandler, isInitializeRequest, isLegacyRequest, McpServer } from '@modelcontextprotocol/server'
import type { RunStore } from '../features/runs/logic/run-store'
import type { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import {
  CANARY_LAB_MCP_PROFILES,
  normalizeCanaryLabMcpProfile,
  registerCanaryLabTools,
  toolsForCanaryLabMcpProfile,
  type CanaryLabMcpDeps,
  type CanaryLabMcpProfile,
} from './tools'
import { classifyMcpClient } from './client-surface'
import { isClientKind, type ClientKind } from '../../../../shared/run-mode'
import { CANARY_LAB_MCP_PROTOCOL_VERSION } from '../../../../shared/mcp-protocol'
import { INSTRUCTIONS_BY_PROFILE } from './instructions'

// MCP endpoint mounted on the existing Fastify instance at `/mcp`. Uses
// streamable HTTP so Claude / Codex clients (Desktop or CLI) and other MCP
// clients (mcp-inspector, custom scripts) can connect over plain HTTP.
//
// The implementation is intentionally thin: every tool is a wrapper around an
// existing REST endpoint or internal helper. The MCP server doesn't own
// state — RunStore + ExternalHealBroker do. The published surface is tools only.

export interface McpRouteDeps extends CanaryLabMcpDeps {
  store: RunStore
  broker: ExternalHealBroker
  featuresDir: string
  projectRoot: string
  /** Same startRun factory used by the runs route — lets MCP `start_run`
   *  reuse the production code path (envset apply, repo validation, admission/
   *  collision, etc.). Inherited signature from CanaryLabMcpDeps. */
  startRun: CanaryLabMcpDeps['startRun']
}

const SERVER_INFO = { name: 'canary-lab', version: '1.0.0', title: 'Canary Lab' }

export function mcpRequestUrl(requestInfo: { url?: string } | undefined): string {
  return requestInfo?.url ?? '/mcp'
}

export function mcpErrorLogger(
  app: Pick<FastifyInstance, 'log'>,
  message: string,
): (err: unknown) => void {
  return (err) => app.log.error({ err }, message)
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  deps: McpRouteDeps,
): Promise<void> {
  // One McpServer + StreamableHTTPServerTransport pair per MCP session.
  // The transport sets an "initialized" flag on its first handshake and
  // rejects every later initialize with -32600 "Server already
  // initialized", so a singleton would cap us at one MCP client per
  // Fastify boot. Keyed by the session id the transport mints on init.
  const transports = new Map<string, NodeStreamableHTTPServerTransport>()

  // The session's McpServer, kept alongside its transport. Previously it was
  // constructed in newSession and dropped on the floor, so nothing could reach
  // `.server.getClientVersion()` / `.getClientCapabilities()` — which is why
  // Canary never knew WHICH client was connected and instructed a subagent-less
  // Desktop chat client exactly like the CLI. Read-only bookkeeping: the
  // transport still owns the session lifecycle.
  const sessionServers = new Map<string, McpServer>()

  // Tool counts are static per profile — register tools on detached McpServer
  // instances (never connected to a transport) so /mcp/health can answer
  // without requiring an active MCP session.
  const toolCounts = Object.fromEntries(
    CANARY_LAB_MCP_PROFILES.map((profile) => [profile, countToolsForProfile(deps, profile)]),
  ) as Record<CanaryLabMcpProfile, number>

  const buildServer = (
    profile: CanaryLabMcpProfile,
    defaultClientKind: ClientKind | undefined,
  ): McpServer => {
    const mcp = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS_BY_PROFILE[profile] })
    registerCanaryLabTools(mcp, deps, {
      profile,
      defaultClientKind,
      onExecCall: (event) => {
        app.log.info({
          command: event.command,
          durationMs: event.durationMs,
          success: event.success,
          validationError: event.validationError ?? false,
        }, 'Canary Lab compact MCP command')
      },
    })
    return mcp
  }

  // MCP 2026-07-28 is stateless: every request carries its protocol revision,
  // client identity and capabilities. Keep the existing sessionful host below
  // for 2025 clients, while this strict entry owns every modern-enveloped
  // request. One tool factory backs both paths so their profiles cannot drift.
  const modernHandler = createMcpHandler(({ requestInfo }) => {
    // `handle` validates this same request URL before it delegates to the
    // modern adapter, so the factory cannot receive the error arm.
    const context = contextFromUrl(mcpRequestUrl(requestInfo)) as {
      ok: true
      profile: CanaryLabMcpProfile
      clientKind: ClientKind | undefined
    }
    return buildServer(context.profile, context.clientKind)
  }, {
    legacy: 'reject',
    onerror: mcpErrorLogger(app, 'MCP 2026 handler rejected a request'),
  })
  const handleModern = toNodeHandler(modernHandler, {
    onerror: mcpErrorLogger(app, 'MCP 2026 Node adapter failed'),
  })
  app.addHook('onClose', async () => modernHandler.close())

  const newSession = async (
    profile: CanaryLabMcpProfile,
    // undefined = the connect URL carried no client_kind; the session then
    // brands itself from the initialize handshake (see registerCanaryLabTools).
    defaultClientKind: ClientKind | undefined,
  ): Promise<NodeStreamableHTTPServerTransport> => {
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport)
        sessionServers.set(id, mcp)
      },
    })
    // One cleanup path for every way a session can end. The transport's
    // `onsessionclosed` hook fires only for a client DELETE, while `onclose`
    // covers that *and* any close the transport initiates itself — so wiring
    // both meant the second one always ran against maps the first had already
    // emptied. The entry is found by identity rather than by reading
    // `transport.sessionId`, which is typed nullable and would need a guard no
    // reachable close can take (a transport only closes after its handshake).
    //
    // ORDERING IS LOAD-BEARING: this assignment must stay ABOVE `mcp.connect`
    // below. The SDK's `Protocol.connect` CHAINS whatever `onclose` it finds
    // rather than replacing it, so assigning first means both handlers run.
    // Moving this after the connect would silently drop the SDK's own cleanup.
    transport.onclose = () => {
      for (const [id, live] of transports) {
        if (live !== transport) continue
        transports.delete(id)
        sessionServers.delete(id)
      }
    }
    const mcp = buildServer(profile, defaultClientKind)
    await mcp.connect(transport)
    return transport
  }

  // Fastify pre-parses the JSON body, so we hand it to handleRequest as the
  // pre-parsed `parsedBody` argument. The transport handles GET (SSE stream),
  // POST (client→server message), and DELETE (close session).
  const handle = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      // Use the SDK's classifier rather than duplicating its envelope rules.
      // Passing Fastify's parsed body keeps the raw Node stream untouched for
      // the adapter that serves the selected modern request immediately after.
      const webRequest = await toWebRequest(req.raw, req.body)
      if (!await isLegacyRequest(webRequest, req.body)) {
        const context = contextFromUrl(req.url)
        if (!context.ok) {
          reply.code(400).send({
            jsonrpc: '2.0',
            error: { code: -32602, message: context.error },
            id: null,
          })
          return
        }
        await handleModern(req.raw, reply.raw, req.body)
        return
      }

      // Fastify types every header as `string | string[]`, but Node's parser
      // only hands back an array for `set-cookie`: a repeated Mcp-Session-Id
      // arrives already comma-joined, and that joined value simply matches no
      // session and 404s below. `toString()` keeps the type in step with that
      // instead of leaving an array arm no request can reach.
      const sessionId = req.headers['mcp-session-id']?.toString()

      let transport: NodeStreamableHTTPServerTransport
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
      // sending, our Fastify layer needs to close the reply cleanly. No
      // `reply.sent` guard: every refusal above sends and returns in the same
      // breath, so nothing inside the try can throw after a reply went out —
      // and a reply the transport already wrote to res.raw leaves `sent` false
      // anyway, so the guard never protected that case either.
      app.log.error({ err }, 'MCP transport.handleRequest threw')
      reply.code(500).send({ error: (err as Error).message })
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
      protocolVersion: CANARY_LAB_MCP_PROTOCOL_VERSION,
      // A bare health probe has no initialize handshake to brand itself from,
      // so an absent param reports the same 'other' a kind-less session used
      // to get; real sessions resolve the fallback per call instead.
      clientKind: context.clientKind ?? 'other',
      toolCount: toolCounts[context.profile],
      tools: toolsForCanaryLabMcpProfile(context.profile),
      activeSessions: transports.size,
      // What is actually on the other end of each live session. Exposed as a
      // PROBE: it answers "does any real client declare sampling?" and "which
      // Claude surface is this?" from live handshakes instead of from a guess,
      // and it is the cheapest way to confirm a capability landed before any
      // feature is built on it.
      clients: [...sessionServers.entries()].map(([sessionId, mcp]) => ({
        sessionId,
        ...classifyMcpClient(mcp.server.getClientVersion(), mcp.server.getClientCapabilities()),
      })),
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
  | { ok: true; profile: CanaryLabMcpProfile; clientKind: ClientKind | undefined }
  | { ok: false; error: string } {
  const params = new URL(url, 'http://localhost').searchParams
  const rawProfile = params.get('profile') ?? undefined
  const profile = normalizeCanaryLabMcpProfile(rawProfile)
  if (!profile) return { ok: false, error: `invalid MCP profile: ${rawProfile}` }
  // An absent param means "not stated", not "other": the session falls back to
  // the initialize handshake identity (clientKindFromFacts), so the bridge's
  // explicit param stays authoritative — including the runner's `*-pty` kinds
  // that suppress heal claiming — while a raw HTTP client is still branded by
  // who its handshake says it is instead of as a generic "AI Agent".
  const rawClientKind = params.get('client_kind')
  if (rawClientKind === null) return { ok: true, profile, clientKind: undefined }
  if (!isClientKind(rawClientKind)) {
    return { ok: false, error: `invalid MCP client_kind: ${rawClientKind}` }
  }
  return { ok: true, profile, clientKind: rawClientKind }
}

function countTools(mcp: McpServer): number {
  // The McpServer keeps registered tools on a private field; the public
  // surface doesn't expose a count. Introspection — we cast to any only here so
  // the rest of the file stays typed. The field is initialized in the SDK's
  // constructor, so it is always an object; an SDK rename would throw here
  // rather than silently report every profile as having zero tools, which the
  // smoke test's tool-count mirror would then have to catch on its own.
  const tools = (mcp as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
  return Object.keys(tools).length
}
