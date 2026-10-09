import Fastify from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { registerMcpRoutes } from '../server'
import { RunStore } from '../../features/runs/logic/run-store'
import { createRegistry } from '../../features/runs/logic/run-registry'
import { ExternalHealBroker } from '../../features/runs/logic/heal/external-heal-broker'
import { CANARY_LAB_MCP_PROTOCOL_VERSION } from '../../../../../shared/mcp-protocol'

// The MCP smoke suites drive the real HTTP transport through the real SDK
// client. These are the three pieces each of them needs: a client, a way to
// read a tool's answer, and a bare MCP server over a real run store.

// The SDK's callTool() return type is a union of the normal tool-result shape
// and a legacy/task shape that only carries an index signature; TS collapses
// `.content` across that union to `unknown`, and `unknown?.[0]` then reports
// as unindexable `{}` at every call site. Centralize the one cast here instead
// of repeating it at every assertion.
export type ToolCallResult = Awaited<ReturnType<Client['callTool']>>

/** The first content block's text, or `''` when there is none. Lenient on
 *  purpose, unlike `toolResultText`: a smoke assertion on the text then fails
 *  with the text it got rather than with a shape error. */
export function smokeToolText(result: ToolCallResult): string {
  const content = (result as { content?: unknown }).content
  const first = Array.isArray(content) ? (content[0] as { type?: string; text?: string } | undefined) : undefined
  return first?.text ?? ''
}

export interface SmokeClientOptions {
  /** The client name sent in `initialize`; some server behaviour keys off it. */
  clientName?: string
  /** Pin the protocol version Canary Lab speaks instead of letting the SDK
   *  negotiate its own default. */
  modern?: boolean
}

/** A connected SDK client on `pathAndQuery` (the profile and client-kind
 *  query live there). The caller closes it. */
export async function connectSmokeClient(
  address: string,
  pathAndQuery = '/mcp',
  { clientName = 'canary-lab-smoke', modern = false }: SmokeClientOptions = {},
): Promise<Client> {
  const client = new Client(
    { name: clientName, version: '0.0.1' },
    {
      capabilities: {},
      ...(modern
        ? { versionNegotiation: { mode: { pin: CANARY_LAB_MCP_PROTOCOL_VERSION } } as const }
        : {}),
    },
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(pathAndQuery, address)))
  return client
}

type McpRouteOptions = Parameters<typeof registerMcpRoutes>[1]

export interface McpHarnessOptions extends Partial<Pick<McpRouteOptions, 'restartExternalRun' | 'startVerification' | 'flightsRequest'>> {
  logsDir: string
  projectRoot: string
  featuresDir: string
  /** Defaults to one that reports a started run, so a tool that launches a
   *  run succeeds without a real orchestrator. */
  startRun?: McpRouteOptions['startRun']
}

/** The MCP routes alone on a Fastify app, over a real run store and heal
 *  broker. The caller listens on it and closes it. */
export async function createMcpHarness(opts: McpHarnessOptions) {
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
    flightsRequest: opts.flightsRequest,
  })
  return { app, runStore }
}
