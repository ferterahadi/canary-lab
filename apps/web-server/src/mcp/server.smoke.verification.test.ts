import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import Fastify from 'fastify'
import { registerMcpRoutes } from './server'
import { createRegistry, RunStore } from '../features/runs/logic/run-store'
import { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

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

  it('exposes verification config, execution, and result tools', async () => {
    const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-verify-')))
    const featuresDir = path.join(projectRoot, 'features')
    const logsDir = path.join(projectRoot, 'logs')
    const featureDir = path.join(featuresDir, 'checkout')
    fs.mkdirSync(path.join(featureDir, 'envsets', 'production'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'production', 'checkout.env'), 'GATEWAY_URL=https://api.example.com\n')
    fs.writeFileSync(
      path.join(featureDir, 'feature.config.cjs'),
      `module.exports = { config: {
        name: 'checkout',
        description: 'checkout',
        envs: ['production'],
        repos: [{ name: 'api', localPath: __dirname, startCommands: [{ name: 'api-server', command: 'npm run dev' }] }],
        featureDir: __dirname,
      } }`,
    )

    const executions: unknown[] = []
    let harnessStore: RunStore | null = null
    const { app, runStore } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir,
      startVerification: async (feature, input) => {
        executions.push({ feature, input })
        harnessStore!.bootstrap({
          runId: 'verify-run-1',
          executionType: 'verify',
          feature,
          env: input.playwrightEnvsetId,
          startedAt: '2026-05-24T00:00:00.000Z',
          status: 'running',
          healCycles: 0,
          services: [],
          verification: {
            configName: 'Production',
            playwrightEnvsetId: input.playwrightEnvsetId ?? 'production',
            targetUrls: input.targetUrls ?? { 'api-server': 'https://api.example.com' },
            targets: [{ id: 'api-server', name: 'api', url: 'https://api.example.com' }],
          },
        })
        return { runId: 'verify-run-1' }
      },
    })
    harnessStore = runStore

    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=verify')

      const created = await client.callTool({
        name: 'create_verification_config',
        arguments: {
          featureId: 'checkout',
          name: 'Production',
          playwrightEnvsetId: 'production',
          targetUrls: { 'api-server': 'https://api.example.com' },
        },
      })
      const createdBody = JSON.parse(toolText(created)) as { id: string }

      const listed = await client.callTool({
        name: 'list_verification_configs',
        arguments: { featureId: 'checkout' },
      })
      expect(JSON.parse(toolText(listed))).toHaveLength(1)

      const updated = await client.callTool({
        name: 'update_verification_config',
        arguments: {
          featureId: 'checkout',
          configId: createdBody.id,
          name: 'Beta',
          playwrightEnvsetId: 'production',
          targetUrls: { 'api-server': 'https://beta.example.com' },
        },
      })
      expect(JSON.parse(toolText(updated))).toMatchObject({
        id: createdBody.id,
        name: 'Beta',
      })

      const executed = await client.callTool({
        name: 'execute_verification',
        arguments: {
          featureId: 'checkout',
          playwrightEnvsetId: 'production',
          targetUrls: { 'api-server': 'https://api.example.com' },
        },
      })
      expect(JSON.parse(toolText(executed))).toMatchObject({
        executionId: 'verify-run-1',
        executionType: 'verify',
        status: 'running',
        playwrightEnvsetId: 'production',
      })
      expect(executions).toEqual([
        {
          feature: 'checkout',
          input: {
            playwrightEnvsetId: 'production',
            targetUrls: { 'api-server': 'https://api.example.com' },
          },
        },
      ])

      runStore.patchManifest('verify-run-1', {
        status: 'failed',
        verification: {
          configName: 'Production',
          playwrightEnvsetId: 'production',
          targetUrls: { 'api-server': 'https://api.example.com' },
          targets: [{ id: 'api-server', name: 'api', url: 'https://api.example.com' }],
          diagnostics: {
            generatedAt: '2026-05-24T00:00:01.000Z',
            summary: '1 Playwright test failed during deployment verification.',
            targetUrls: { 'api-server': 'https://api.example.com' },
            failedTests: [{ name: 'loads home', targetUrl: 'https://api.example.com' }],
          },
        },
      })
      const result = await client.callTool({
        name: 'get_verification_result',
        arguments: { executionId: 'verify-run-1' },
      })
      expect(JSON.parse(toolText(result))).toMatchObject({
        executionId: 'verify-run-1',
        executionType: 'verify',
        status: 'failed',
        diagnostics: {
          failedTests: [{ name: 'loads home' }],
        },
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})
