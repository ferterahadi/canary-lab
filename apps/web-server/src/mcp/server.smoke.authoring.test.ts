import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import Fastify from 'fastify'
import { registerMcpRoutes } from './server'
import { createRegistry, RunStore } from '../features/runs/logic/run-store'
import { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import { runDirFor } from '../features/runs/logic/runtime/run-paths'
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

  it('drives external feature authoring, env capture, drafts, and evaluation export without local agent spawns', async () => {
    const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-author-')))
    const featuresDir = path.join(projectRoot, 'features')
    const logsDir = path.join(projectRoot, 'logs')
    const repoDir = path.join(projectRoot, 'repo-api')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(path.join(repoDir, '.env.dev'), 'API_KEY=secret\nGATEWAY_URL=http://localhost:4100\n')
    fs.writeFileSync(path.join(repoDir, 'application.properties'), 'spring.datasource.password=secret2\n')

    const { app, runStore } = await createMcpHarness({ logsDir, projectRoot, featuresDir })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      // The flow spans authoring + coverage + export tools, which live in three
      // leaf profiles since the repartition — lifecycle is their union.
      client = await connectClient(address, '/mcp?profile=lifecycle&client_kind=codex')

      const created = await client.callTool({
        name: 'create_feature',
        arguments: {
          feature: 'checkout_flow',
          description: 'Checkout flow',
          envs: ['local', 'staging'],
          repos: [{ name: 'api', localPath: repoDir, branch: 'main' }],
        },
      })
      const createdBody = JSON.parse(toolText(created))
      expect(createdBody).toMatchObject({
        feature: 'checkout_flow',
        nextSteps: expect.arrayContaining(['capture_feature_env_files', 'start_external_draft', 'apply_external_draft']),
      })
      const featureDir = path.join(featuresDir, 'checkout_flow')
      expect(fs.existsSync(path.join(featureDir, 'feature.config.cjs'))).toBe(true)
      expect(fs.existsSync(path.join(featureDir, 'e2e', 'checkout_flow.spec.ts'))).toBe(false)

      // A fresh feature has no source doc → coverage is blocked and must steer the agent to
      // ASK the user for the PRD (not invent one), via the `next:` field on the ledger.
      const blockedCoverage = await client.callTool({
        name: 'get_feature_coverage',
        arguments: { feature: 'checkout_flow' },
      })
      const blockedBody = JSON.parse(toolText(blockedCoverage))
      expect(blockedBody.state.coverage).toBe('blocked')
      expect(blockedBody.next).toMatch(/attach or paste the PRD/i)
      expect(blockedBody.next).toContain('checkout_flow')

      const captured = await client.callTool({
        name: 'capture_feature_env_files',
        arguments: {
          feature: 'checkout_flow',
          sources: [
            { env: 'local', sourcePath: path.join(repoDir, '.env.dev'), slot: 'api.env.dev' },
            { env: 'staging', sourcePath: path.join(repoDir, 'application.properties'), slot: 'api-application.properties' },
          ],
        },
      })
      const capturedBody = JSON.parse(toolText(captured))
      expect(capturedBody.captured).toHaveLength(2)
      expect(capturedBody.captured[0].preview).toContainEqual({ key: 'API_KEY', value: '********' })
      expect(fs.readFileSync(path.join(featureDir, 'envsets', 'local', 'api.env.dev'), 'utf8')).toContain('API_KEY=secret')

      const summary = await client.callTool({
        name: 'get_feature_envset_summary',
        arguments: { feature: 'checkout_flow' },
      })
      const summaryBody = JSON.parse(toolText(summary))
      expect(summaryBody.envs.map((env: { name: string }) => env.name)).toEqual(['local', 'staging'])
      expect(JSON.stringify(summaryBody)).not.toContain('secret')

      const draft = await client.callTool({
        name: 'start_external_draft',
        arguments: {
          feature: 'checkout_flow',
          stage: 'authoring-tests',
          session_id: 'sess-author-1',
          conversation_name: 'Add checkout tests',
          external_session_url: 'codex://session/sess-author-1',
        },
      })
      const draftBody = JSON.parse(toolText(draft))
      expect(draftBody).toMatchObject({
        feature: 'checkout_flow',
        producer: 'external',
        externalStage: 'authoring-tests',
        sessionId: 'sess-author-1',
        canaryLabBehavior: 'tracking-only',
        statusMeaning: 'External client is authoring tests; Canary Lab is not running an internal wizard agent.',
      })
      expect(draftBody.nextSteps).toEqual([
        'Tell the user you are authoring tests now and they can wait in the external client.',
        'Author or edit Playwright specs under features/checkout_flow/e2e.',
        'Call update_external_draft_stage as progress changes.',
        'Call apply_external_draft when the files are ready to validate and record.',
      ])

      const applied = await client.callTool({
        name: 'apply_external_draft',
        arguments: {
          draftId: draftBody.draftId,
          confirm: true,
          files: [{
            path: 'e2e/checkout.spec.ts',
            content: "import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'\n\ntest('checkout works', async () => { expect(true).toBe(true) })\n",
          }],
        },
      })
      expect(JSON.parse(toolText(applied))).toMatchObject({
        status: 'applied',
        feature: 'checkout_flow',
      })
      expect(fs.readFileSync(path.join(featureDir, 'e2e', 'checkout.spec.ts'), 'utf8')).toContain('checkout works')

      runStore.bootstrap({
        runId: 'author-eval-run',
        feature: 'checkout_flow',
        featureDir,
        startedAt: '2026-05-27T00:00:00.000Z',
        endedAt: '2026-05-27T00:01:00.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
      })
      const evalRunDir = runDirFor(logsDir, 'author-eval-run')
      fs.writeFileSync(path.join(evalRunDir, 'e2e-summary.json'), JSON.stringify({
        complete: true,
        total: 1,
        passed: 1,
        passedNames: ['test-case-checkout-works'],
        failed: [],
      }))
      fs.writeFileSync(
        path.join(evalRunDir, 'playwright-events.jsonl'),
        JSON.stringify({
          type: 'test-end',
          time: '2026-05-27T00:01:00.000Z',
          test: {
            name: 'test-case-checkout-works',
            title: 'checkout works',
            location: `${path.join(featureDir, 'e2e', 'checkout.spec.ts')}:3`,
          },
          status: 'passed',
          passed: true,
          durationMs: 42,
          retry: 0,
        }) + '\n',
      )
      const exportTask = await client.callTool({
        name: 'start_external_evaluation_export',
        arguments: {
          runId: 'author-eval-run',
          language: 'English',
          session_id: 'sess-author-1',
          conversation_name: 'Export this into evaluation',
        },
      })
      const exportBody = JSON.parse(toolText(exportTask))
      expect(exportBody).toMatchObject({
        task: { producer: 'external', status: 'running', language: 'English' },
        reportSchema: {
          output: 'evaluation.html',
          textSlots: expect.any(Array),
          rewrite: expect.any(Object),
        },
        nextSteps: expect.arrayContaining(['author structured evaluation wording', 'submit_external_evaluation_export']),
      })
      expect(JSON.stringify(exportBody.reportSchema)).not.toContain('evaluation.md')
      expect(exportBody.reportSchema.textSlots.length).toBeGreaterThan(0)
      // The verbose run snapshot is no longer embedded — the agent fetches it on
      // demand via get_run instead of paying for it on every export start
      // (get_run_snapshot is not in the export profile's tool set).
      expect(exportBody).not.toHaveProperty('runContext')
      expect(exportBody.runSnapshotVia).toContain('get_run(')

      const rejectedMarkdown = await client.callTool({
        name: 'submit_external_evaluation_export',
        arguments: {
          taskId: exportBody.task.taskId,
          files: [{ path: 'evaluation.md', content: '# Checkout evaluation\nGenerated externally.\n' }],
        },
      })
      expect(rejectedMarkdown.isError).toBe(true)
      expect(toolText(rejectedMarkdown)).toBe('submit textSlots[] or rewrite')

      const submittedExport = await client.callTool({
        name: 'submit_external_evaluation_export',
        arguments: {
          taskId: exportBody.task.taskId,
          textSlots: exportBody.reportSchema.textSlots.map((slot: { id: string; text: string }) =>
            slot.id === 'summary'
              ? { ...slot, text: 'Externally reviewed checkout wording rendered by Canary Lab.' }
              : slot,
          ),
        },
      })
      const submittedBody = JSON.parse(toolText(submittedExport))
      expect(submittedBody).toMatchObject({
        status: 'completed',
        downloadReady: true,
        // The submit result now carries a chat-ready digest the agent relays.
        evaluation: {
          summary: 'Externally reviewed checkout wording rendered by Canary Lab.',
          cases: [expect.objectContaining({ title: expect.any(String), confidence: expect.any(String) })],
        },
      })
      // nextSteps steer the agent to surface the result, not just point at the UI.
      expect(submittedBody.nextSteps.some((step: string) => step.includes('Present this evaluation'))).toBe(true)
      expect(submittedBody.nextSteps.some((step: string) => step.includes('download_evaluation_export'))).toBe(true)
      const fetchedExport = await client.callTool({
        name: 'get_evaluation_export',
        arguments: { taskId: exportBody.task.taskId },
      })
      expect(JSON.parse(toolText(fetchedExport))).toMatchObject({
        producer: 'external',
        status: 'completed',
        downloadReady: true,
      })
      const download = await client.callTool({
        name: 'download_evaluation_export',
        arguments: { taskId: exportBody.task.taskId },
      })
      const downloadBody = JSON.parse(toolText(download))
      expect(downloadBody.filename).toMatch(/checkout_flow-author-eval-run\.zip$/)
      const archiveText = Buffer.from(downloadBody.archiveBase64, 'base64').toString('latin1')
      expect(archiveText).toContain('evaluation.html')
      expect(archiveText).not.toContain('evaluation.md')
      expect(archiveText).toContain('Externally reviewed checkout wording rendered by Canary Lab.')
      expect(archiveText).toContain('class="flowchart"')
      expect(archiveText).toContain('<summary>Test code</summary>')
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})
