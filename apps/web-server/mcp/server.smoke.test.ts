import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import Fastify from 'fastify'
import { createServer } from '../server'
import { registerMcpRoutes } from './server'
import { createRegistry, RunStore } from '../lib/run-store'
import { ExternalHealBroker } from '../lib/external-heal-broker'
import type { PtyFactory } from '../lib/runtime/pty-spawner'
import { runDirFor } from '../lib/runtime/run-paths'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

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
  'cancel_heal',
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
  'delete_evaluation_export',
  'delete_feature',
  'download_evaluation_export',
  'get_evaluation_export',
  'get_feature_envset_summary',
  'get_feature_repo_status',
  'get_run',
  'get_run_snapshot',
  'list_evaluation_exports',
  'list_features',
  'list_runs',
  'start_external_draft',
  'start_external_evaluation_export',
  'submit_external_evaluation_export',
  'update_external_draft_stage',
  'write_envset',
  'write_feature_doc',
])

const FULL_TOOLS = uniqueSorted([
  ...AUTHOR_TOOLS,
  'abort_run',
  'cancel_heal',
  'claim_heal',
  'create_verification_config',
  'execute_verification',
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
])

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
    startRun: opts.startRun ?? (async () => ({ runId: 'new-run' })),
    restartExternalRun: opts.restartExternalRun,
    startVerification: opts.startVerification,
  })
  return { app, runStore }
}

describe('MCP HTTP server (smoke)', () => {
  it('exposes /mcp/health with profile-specific tool counts', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    try {
      const res = await app.inject({ method: 'GET', url: '/mcp/health' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { ok: boolean; server: { name: string }; toolCount: number; profile: string; tools: string[] }
      expect(body.ok).toBe(true)
      expect(body.server.name).toBe('canary-lab')
      expect(body.profile).toBe('full')
      expect(body.toolCount).toBe(FULL_TOOLS.length)
      expect([...body.tools].sort()).toEqual(FULL_TOOLS)

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
    } finally {
      await app.close()
    }
  })

  it('rejects invalid MCP profiles before creating sessions', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
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

  it('answers tools/list with the default full profile and tools/call over the streamable HTTP transport', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address)

      const tools = await client.listTools()
      const names = tools.tools.map((t) => t.name).sort()
      expect(names).toEqual(FULL_TOOLS)

      // tools/call list_features — should return the templates/project scaffold.
      const result = await client.callTool({ name: 'list_features', arguments: {} })
      const text = (result.content?.[0] as { type: string; text: string } | undefined)?.text ?? ''
      const features = JSON.parse(text) as Array<{ name: string }>
      const featureNames = features.map((f) => f.name).sort()
      expect(featureNames).toContain('broken_todo_api')
      expect(featureNames).toContain('example_todo_api')
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('answers tools/list with the full profile', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
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
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
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
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
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
      client = await connectClient(address, '/mcp?profile=author&client_kind=codex-cli')

      const created = await client.callTool({
        name: 'create_feature',
        arguments: {
          feature: 'checkout_flow',
          description: 'Checkout flow',
          envs: ['local', 'staging'],
          repos: [{ name: 'api', localPath: repoDir, branch: 'main' }],
        },
      })
      const createdBody = JSON.parse((created.content?.[0] as { text: string }).text)
      expect(createdBody).toMatchObject({
        feature: 'checkout_flow',
        nextSteps: expect.arrayContaining(['capture_feature_env_files', 'start_external_draft', 'apply_external_draft']),
      })
      const featureDir = path.join(featuresDir, 'checkout_flow')
      expect(fs.existsSync(path.join(featureDir, 'feature.config.cjs'))).toBe(true)
      expect(fs.existsSync(path.join(featureDir, 'e2e', 'checkout_flow.spec.ts'))).toBe(false)

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
      const capturedBody = JSON.parse((captured.content?.[0] as { text: string }).text)
      expect(capturedBody.captured).toHaveLength(2)
      expect(capturedBody.captured[0].preview).toContainEqual({ key: 'API_KEY', value: '********' })
      expect(fs.readFileSync(path.join(featureDir, 'envsets', 'local', 'api.env.dev'), 'utf8')).toContain('API_KEY=secret')

      const summary = await client.callTool({
        name: 'get_feature_envset_summary',
        arguments: { feature: 'checkout_flow' },
      })
      const summaryBody = JSON.parse((summary.content?.[0] as { text: string }).text)
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
      const draftBody = JSON.parse((draft.content?.[0] as { text: string }).text)
      expect(draftBody).toMatchObject({
        feature: 'checkout_flow',
        source: 'external',
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
      expect(JSON.parse((applied.content?.[0] as { text: string }).text)).toMatchObject({
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
      const exportBody = JSON.parse((exportTask.content?.[0] as { text: string }).text)
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

      const rejectedMarkdown = await client.callTool({
        name: 'submit_external_evaluation_export',
        arguments: {
          taskId: exportBody.task.taskId,
          files: [{ path: 'evaluation.md', content: '# Checkout evaluation\nGenerated externally.\n' }],
        },
      })
      expect(rejectedMarkdown.isError).toBe(true)
      expect((rejectedMarkdown.content?.[0] as { text: string }).text).toBe('submit textSlots[] or rewrite')

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
      expect(JSON.parse((submittedExport.content?.[0] as { text: string }).text)).toMatchObject({
        status: 'completed',
        downloadReady: true,
        nextSteps: expect.arrayContaining(['download_evaluation_export']),
      })
      const fetchedExport = await client.callTool({
        name: 'get_evaluation_export',
        arguments: { taskId: exportBody.task.taskId },
      })
      expect(JSON.parse((fetchedExport.content?.[0] as { text: string }).text)).toMatchObject({
        producer: 'external',
        status: 'completed',
        downloadReady: true,
      })
      const download = await client.callTool({
        name: 'download_evaluation_export',
        arguments: { taskId: exportBody.task.taskId },
      })
      const downloadBody = JSON.parse((download.content?.[0] as { text: string }).text)
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

  it('accepts back-to-back initialize handshakes from independent clients', async () => {
    // Regression for the singleton-transport bug: a single McpServer +
    // StreamableHTTPServerTransport pair flips an "initialized" flag on
    // first handshake and rejects every later initialize with -32600
    // "Server already initialized". That meant exactly one MCP client per
    // Fastify boot. The route must mint a fresh transport per session.
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const url = `${address}/mcp`
      const initBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'regression-probe', version: '0.0.1' },
        },
      })
      const initOnce = async (): Promise<{ status: number; sid: string | null }> => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: initBody,
        })
        // Drain the body so the connection can be reused / cleaned up.
        await res.text()
        return { status: res.status, sid: res.headers.get('mcp-session-id') }
      }
      const first = await initOnce()
      const second = await initOnce()
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(first.sid).toBeTruthy()
      expect(second.sid).toBeTruthy()
      expect(first.sid).not.toBe(second.sid)
    } finally {
      await app.close()
    }
  })

  it('rejects abort_run without confirm: true (schema-level gate)', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const url = new URL('/mcp', address)
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: {} },
      )
      const transport = new StreamableHTTPClientTransport(url)
      await client.connect(transport)

      // Call abort_run with no confirm field — the zod schema requires
      // `confirm: z.literal(true)`, so the SDK should reject the call with
      // an isError result before we ever hit the handler.
      const result = await client.callTool({
        name: 'abort_run',
        arguments: { runId: 'not-a-real-run' },
      })
      expect(result.isError).toBe(true)
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('get_heal_context returns compact context and get_run_snapshot returns the full fallback', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-context-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address)

      runStore.bootstrap({
        runId: 'context-map',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
        repoPaths: ['/repo/app'],
      })
      const runDir = runDirFor(logsDir, 'context-map')
      fs.writeFileSync(path.join(runDir, 'heal-index.md'), '# Heal Index\n')
      fs.writeFileSync(path.join(runDir, 'diagnosis-journal.md'), '# Journal\n')
      fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({
        complete: false,
        total: 3,
        passed: 1,
        passedNames: ['test-1'],
        knownTests: [
          { name: 'test-1' },
          { name: 'test-2' },
          { name: 'test-3' },
        ],
        failed: [
          {
            name: 'test-2',
            error: { message: 'boom' },
            location: 'e2e/example.spec.ts:10',
            logFiles: ['failed/test-2/svc-app.log'],
          },
        ],
      }))
      fs.mkdirSync(path.join(runDir, 'failed', 'test-case', 'trace-extract'), { recursive: true })
      fs.writeFileSync(path.join(runDir, 'failed', 'test-case', 'trace-extract', 'failure-summary.md'), '# Trace\n')

      const result = await client.callTool({
        name: 'get_heal_context',
        arguments: { runId: 'context-map', session_id: 'sess-context' },
      })
      const body = JSON.parse((result.content?.[0] as { text: string }).text)

      expect(body).toMatchObject({
        runId: 'context-map',
        feature: 'broken_todo_api',
        counts: {
          totalKnown: 3,
          passed: 1,
          failed: 1,
          skipped: 0,
          notRun: 1,
          statusLine: '1/3 passed, 1 failed, 1 not run',
        },
        healIndex: {
          path: path.join(runDir, 'heal-index.md'),
          markdown: '# Heal Index\n',
        },
        journal: {
          path: path.join(runDir, 'diagnosis-journal.md'),
          markdown: '# Journal\n',
        },
        failedTests: [
          {
            name: 'test-2',
            logFiles: ['failed/test-2/svc-app.log'],
          },
        ],
      })
      expect(body).not.toHaveProperty('summary')
      expect(body).not.toHaveProperty('healIndexMarkdown')
      expect(body).not.toHaveProperty('journalMarkdown')
      expect(body.counts).not.toHaveProperty('notRunNames')
      expect(JSON.stringify(body)).not.toContain('test-3')
      expect(body.healPrompt).toMatchObject({
        source: 'canary-lab/heal-agent-map',
        mode: 'service',
        startHere: [
          {
            id: 'heal-index',
            field: 'healIndexMarkdown',
            path: path.join(runDir, 'heal-index.md'),
          },
        ],
        boundaries: {
          signalPolicy: {
            serviceOrRuntimeChange: 'restart',
            testOrConfigOnlyChange: 'rerun',
            mechanism: 'call signal_run; do not write signal files directly',
          },
        },
      })
      expect(body.healPrompt.resources.map((entry: { id: string }) => entry.id)).toEqual([
        'trace-extract',
        'journal',
      ])

      const snapshotResult = await client.callTool({
        name: 'get_run_snapshot',
        arguments: { runId: 'context-map' },
      })
      const snapshot = JSON.parse((snapshotResult.content?.[0] as { text: string }).text)
      expect(snapshot).toMatchObject({
        runId: 'context-map',
        summary: {
          knownTests: [
            { name: 'test-1' },
            { name: 'test-2' },
            { name: 'test-3' },
          ],
        },
        counts: {
          notRunNames: ['test-3'],
          statusLine: '1/3 passed, 1 failed, 1 not run',
        },
        healIndexMarkdown: '# Heal Index\n',
        journalMarkdown: '# Journal\n',
        artifactsBase: '/api/runs/context-map/artifacts/',
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('signal_run writes canonical restart/rerun journal payloads', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-signal-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address)

      runStore.bootstrap({
        runId: 'journal-run',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 2,
        services: [],
        healMode: 'external',
      })

      const result = await client.callTool({
        name: 'signal_run',
        arguments: {
          runId: 'journal-run',
          kind: 'restart',
          hypothesis: 'route module was disabled',
          fixDescription: 'enabled the module import',
        },
      })
      expect(result.isError).not.toBe(true)

      const signalBody = JSON.parse((result.content?.[0] as { text: string }).text) as { nextSteps?: string[]; runId?: string }
      expect(signalBody.nextSteps).toContain('wait_for_heal_task')
      expect(signalBody.runId).toBe('journal-run')

      const paths = path.join(runDirFor(logsDir, 'journal-run'), 'signals', '.restart')
      expect(fs.readFileSync(paths, 'utf-8')).toBe(JSON.stringify({
        hypothesis: 'route module was disabled',
        fixDescription: 'enabled the module import',
      }))
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('rejects signal_run restart/rerun calls without journal fields', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-signal-validation-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address)

      runStore.bootstrap({
        runId: 'journal-run',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 2,
        services: [],
        healMode: 'external',
      })

      const missingFix = await client.callTool({
        name: 'signal_run',
        arguments: {
          runId: 'journal-run',
          kind: 'rerun',
          hypothesis: 'route module was disabled',
        },
      })
      expect(missingFix.isError).toBe(true)
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('advertises the repair loop via server initialize instructions', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    let repairClient: Client | null = null
    let authorClient: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      repairClient = await connectClient(address, '/mcp?profile=repair')
      const repairInstructions = repairClient.getInstructions() ?? ''
      expect(repairInstructions).toContain('wait_for_heal_task')
      expect(repairInstructions).toContain('signal_run')

      authorClient = await connectClient(address, '/mcp?profile=author')
      const authorInstructions = authorClient.getInstructions() ?? ''
      expect(authorInstructions).toContain('create_feature')
      expect(authorInstructions).toContain('call create_feature directly')
      expect(authorInstructions).toContain('do not call list_features just to avoid collisions')
    } finally {
      if (repairClient) await repairClient.close().catch(() => undefined)
      if (authorClient) await authorClient.close().catch(() => undefined)
      await app.close()
    }
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
      const createdBody = JSON.parse((created.content?.[0] as { text: string }).text) as { id: string }

      const listed = await client.callTool({
        name: 'list_verification_configs',
        arguments: { featureId: 'checkout' },
      })
      expect(JSON.parse((listed.content?.[0] as { text: string }).text)).toHaveLength(1)

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
      expect(JSON.parse((updated.content?.[0] as { text: string }).text)).toMatchObject({
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
      expect(JSON.parse((executed.content?.[0] as { text: string }).text)).toMatchObject({
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
      expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
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

  it('wait_for_heal_task reports needs_heal, terminal states, and timeout', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-wait-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=full')

      runStore.bootstrap({
        runId: 'wait-needs-heal',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
      })
      fs.writeFileSync(path.join(runDirFor(logsDir, 'wait-needs-heal'), 'heal-index.md'), '# Heal Index\n')
      await client.callTool({
        name: 'claim_heal',
        arguments: {
          runId: 'wait-needs-heal',
          session_id: 'sess-1',
          client_kind: 'codex-cli',
        },
      })
      runStore.recordLifecycleEvent('wait-needs-heal', {
        phase: 'waiting-for-signal',
        headline: 'Waiting for heal signal',
        updatedAt: '2026-05-08T00:00:01.000Z',
        activeCycle: 1,
      })
      const needsHeal = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-needs-heal', session_id: 'sess-1', timeout_ms: 1000 },
      })
      const needsHealBody = JSON.parse((needsHeal.content?.[0] as { text: string }).text)
      expect(needsHealBody).toMatchObject({
        type: 'needs_heal',
        runId: 'wait-needs-heal',
        cycle: 1,
      })
      expect(needsHealBody.context.healPrompt.startHere[0]).toMatchObject({
        id: 'heal-index',
        field: 'healIndexMarkdown',
      })

      runStore.bootstrap({
        runId: 'wait-passed',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'passed',
        healCycles: 0,
        services: [],
      })
      const passed = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-passed', session_id: 'sess-1', timeout_ms: 1000 },
      })
      expect(JSON.parse((passed.content?.[0] as { text: string }).text)).toMatchObject({
        type: 'passed',
        runId: 'wait-passed',
      })

      runStore.bootstrap({
        runId: 'wait-failed',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'failed',
        healCycles: 0,
        services: [],
      })
      const knownTests = Array.from({ length: 21 }, (_, index) => ({
        name: `test-${index + 1}`,
        title: `Test ${index + 1}`,
      }))
      fs.writeFileSync(
        path.join(runDirFor(logsDir, 'wait-failed'), 'e2e-summary.json'),
        JSON.stringify({
          complete: true,
          total: 21,
          passed: 3,
          passedNames: ['test-1', 'test-2', 'test-4'],
          knownTests,
          failed: [
            { name: 'test-3', error: { message: 'C failed' } },
            { name: 'test-5', error: { message: 'E failed' } },
          ],
        }),
      )
      const failed = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-failed', session_id: 'sess-1', timeout_ms: 1000 },
      })
      const failedBody = JSON.parse((failed.content?.[0] as { text: string }).text)
      expect(failedBody).toMatchObject({
        type: 'failed',
        runId: 'wait-failed',
        status: 'failed',
        counts: {
          totalKnown: 21,
          passed: 3,
          failed: 2,
          skipped: 0,
          notRun: 16,
          passedNames: ['test-1', 'test-2', 'test-4'],
          failedNames: ['test-3', 'test-5'],
          skippedNames: [],
          notRunNames: [
            'test-6',
            'test-7',
            'test-8',
            'test-9',
            'test-10',
            'test-11',
            'test-12',
            'test-13',
            'test-14',
            'test-15',
            'test-16',
            'test-17',
            'test-18',
            'test-19',
            'test-20',
            'test-21',
          ],
          statusLine: '3/21 passed, 2 failed, 16 not run',
        },
      })
      expect(JSON.stringify(failedBody)).not.toContain('19/21 passed')

      runStore.bootstrap({
        runId: 'wait-timeout',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'running',
        healCycles: 0,
        services: [],
        healMode: 'external',
      })
      await client.callTool({
        name: 'claim_heal',
        arguments: {
          runId: 'wait-timeout',
          session_id: 'sess-timeout',
          client_kind: 'codex-cli',
        },
      })
      const timeout = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-timeout', session_id: 'sess-timeout', timeout_ms: 10 },
      })
      expect(JSON.parse((timeout.content?.[0] as { text: string }).text)).toMatchObject({
        type: 'timeout',
        runId: 'wait-timeout',
        status: 'running',
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('wait_for_heal_task claims an unclaimed external run with the MCP client kind', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-wait-claim-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address, '/mcp?profile=full&client_kind=claude-desktop')

      runStore.bootstrap({
        runId: 'wait-claim',
        feature: 'broken_todo_api',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
      })
      fs.writeFileSync(path.join(runDirFor(logsDir, 'wait-claim'), 'heal-index.md'), '# Heal Index\n')
      runStore.recordLifecycleEvent('wait-claim', {
        phase: 'waiting-for-signal',
        headline: 'Waiting for heal signal',
        updatedAt: '2026-05-08T00:00:01.000Z',
        activeCycle: 1,
      })

      const result = await client.callTool({
        name: 'wait_for_heal_task',
        arguments: { runId: 'wait-claim', session_id: 'sess-claude', timeout_ms: 1000 },
      })

      const body = JSON.parse((result.content?.[0] as { text: string }).text)
      expect(body).toMatchObject({
        type: 'needs_heal',
        runId: 'wait-claim',
        context: {
          runId: 'wait-claim',
          healIndex: {
            markdown: '# Heal Index\n',
          },
        },
      })
      expect(body.context).not.toHaveProperty('summary')
      expect(body.context).not.toHaveProperty('healIndexMarkdown')
      expect(runStore.get('wait-claim')?.manifest.externalHealSession).toMatchObject({
        sessionId: 'sess-claude',
        clientKind: 'claude-desktop',
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run reuses a healing feature run instead of creating a duplicate', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-reuse-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: {} },
      )
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))

      runStore.bootstrap({
        runId: 'reuse-active',
        feature: 'broken_todo_api',
        env: 'local',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
      })

      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-reuse',
          client_kind: 'claude-desktop',
          conversation_name: 'resume existing run',
        },
      })
      const body = JSON.parse((result.content?.[0] as { text: string }).text)
      expect(body).toMatchObject({
        runId: 'reuse-active',
        reused: true,
        status: 'healing',
        claimed: true,
      })
      expect(runStore.list({ feature: 'broken_todo_api' }).map((entry) => entry.runId)).toEqual(['reuse-active'])
      expect(runStore.get('reuse-active')?.manifest.externalHealSession).toMatchObject({
        sessionId: 'sess-reuse',
        clientKind: 'claude-desktop',
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run asks for a collision choice when a run is already using the same app', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-block-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: {} },
      )
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))

      // A run already occupying the broken_todo_api repo (running, not healing,
      // so the route's heal-reuse path doesn't short-circuit).
      runStore.bootstrap({
        runId: 'busy-run',
        feature: 'broken_todo_api',
        env: 'local',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'running',
        healCycles: 0,
        services: [],
        repoPaths: [path.join(projectRoot, 'features', 'broken_todo_api')],
      })

      // A fresh same-app start detects the collision and asks how to resolve it
      // instead of blindly starting (or the old active_heal_blocks_start).
      const collision = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-block',
          client_kind: 'claude-desktop',
        },
      })
      expect(JSON.parse((collision.content?.[0] as { text: string }).text)).toMatchObject({
        type: 'repo_collision_requires_choice',
        conflictingRunId: 'busy-run',
        options: ['worktree', 'queue'],
      })
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run prefers an existing run that is waiting for heal over a newer running run', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-heal-first-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = new Client(
        { name: 'canary-lab-smoke', version: '0.0.1' },
        { capabilities: {} },
      )
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))

      runStore.bootstrap({
        runId: 'older-waiting-heal',
        feature: 'broken_todo_api',
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
        feature: 'broken_todo_api',
        env: 'local',
        startedAt: '2026-05-08T00:01:00.000Z',
        status: 'running',
        healCycles: 0,
        services: [],
      })

      const result = await client.callTool({
        name: 'start_run',
        arguments: {
          feature: 'broken_todo_api',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-heal-first',
          client_kind: 'claude-desktop',
        },
      })

      expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
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
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-ref-')))
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
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))

      runStore.bootstrap({
        runId: '2026-05-19T0841-7cvh',
        feature: 'broken_todo_api',
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
          feature: 'broken_todo_api',
          env: 'local',
          run_ref: '7cvh',
          claim_heal: true,
          session_id: 'sess-restart',
          client_kind: 'claude-desktop',
        },
      })

	      expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
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
      const restartBody = JSON.parse((result.content?.[0] as { text: string }).text) as { nextSteps?: string[] }
      expect(restartBody.nextSteps).toContain('wait_for_heal_task')
      expect(restarted).toEqual([{ runId: '2026-05-19T0841-7cvh', sessionId: 'sess-restart' }])
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('start_run returns candidates for an ambiguous run suffix', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
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
          feature: 'broken_todo_api',
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
          feature: 'broken_todo_api',
          env: 'local',
          run_ref: '7cvh',
          claim_heal: true,
          session_id: 'sess-ambiguous',
          client_kind: 'claude-desktop',
        },
      })

      const body = JSON.parse((result.content?.[0] as { text: string }).text)
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
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-start-new-')))
    const featuresDir = path.join(projectRoot, 'features')
    const starts: string[] = []
    const { app } = await createMcpHarness({
      logsDir,
      projectRoot,
      featuresDir,
      startRun: async (feature) => {
        starts.push(feature)
        return { runId: 'fresh-run' }
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
          feature: 'broken_todo_api',
          env: 'local',
          claim_heal: true,
          session_id: 'sess-new',
          client_kind: 'claude-desktop',
        },
      })

      expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
        runId: 'fresh-run',
        reused: false,
        claimed: true,
      })
      expect(starts).toEqual(['broken_todo_api'])
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })
})
