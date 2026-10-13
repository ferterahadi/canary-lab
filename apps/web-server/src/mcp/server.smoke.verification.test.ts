import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import { RunStore } from '../features/runs/logic/run-store'
import { Client } from '@modelcontextprotocol/client'
import { connectSmokeClient, createMcpHarness, smokeToolText } from './__fixtures__/smoke-harness'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-mcp-verify-')

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
    const projectRoot = tempDir()
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
          runId: `verify-run-${executions.length}`,
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
        return { runId: `verify-run-${executions.length}` }
      },
    })
    harnessStore = runStore

    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectSmokeClient(address, '/mcp?profile=verify')

      const created = await client.callTool({
        name: 'create_verification_config',
        arguments: {
          featureId: 'checkout',
          name: 'Production',
          playwrightEnvsetId: 'production',
          targetUrls: { 'api-server': 'https://api.example.com' },
        },
      })
      const createdBody = JSON.parse(smokeToolText(created)) as { id: string }

      const listed = await client.callTool({
        name: 'list_verification_configs',
        arguments: { featureId: 'checkout' },
      })
      expect(JSON.parse(smokeToolText(listed))).toHaveLength(1)

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
      expect(JSON.parse(smokeToolText(updated))).toMatchObject({
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
      expect(JSON.parse(smokeToolText(executed))).toMatchObject({
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

      // The local "verify a running app" flow: bootRunId must reach the route
      // input untouched — it is what exempts the held boot session from the
      // active-run collision check and tears it down when verification starts.
      const bootHandoff = await client.callTool({
        name: 'execute_verification',
        arguments: {
          featureId: 'checkout',
          playwrightEnvsetId: 'local',
          targetUrls: { 'api-server': 'http://127.0.0.1:4600' },
          bootRunId: 'boot-run-9',
        },
      })
      expect(JSON.parse(smokeToolText(bootHandoff))).toMatchObject({ executionId: 'verify-run-2' })
      expect(executions[1]).toEqual({
        feature: 'checkout',
        input: {
          playwrightEnvsetId: 'local',
          targetUrls: { 'api-server': 'http://127.0.0.1:4600' },
          bootRunId: 'boot-run-9',
        },
      })

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
      expect(JSON.parse(smokeToolText(result))).toMatchObject({
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
    }
  })
})
