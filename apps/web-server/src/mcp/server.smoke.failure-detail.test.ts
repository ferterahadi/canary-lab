import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { createServer } from '../server'
import type { PtyFactory } from '../features/runs/logic/runtime/pty-spawner'
import { runDirFor } from '../features/runs/logic/runtime/run-paths'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

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

async function connectClient(address: string, pathAndQuery = '/mcp?profile=lifecycle'): Promise<Client> {
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

  it('get_failure_detail returns one failure slice and errors on an unknown failureId', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-failure-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address)

      runStore.bootstrap({
        runId: 'failure-detail',
        feature: 'demo_catalog',
        startedAt: '2026-05-08T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        healMode: 'external',
      })
      const runDir = runDirFor(logsDir, 'failure-detail')
      fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({
        complete: false,
        total: 2,
        passed: 1,
        passedNames: ['test-1'],
        knownTests: [{ name: 'test-1' }, { name: 'test-2' }],
        failed: [
          {
            name: 'test-2',
            error: { message: 'boom' },
            location: 'e2e/example.spec.ts:10',
            logFiles: ['failed/test-2/svc-app.log'],
            errorFile: 'failed/test-2/error.txt',
          },
        ],
      }))
      const traceDir = path.join(runDir, 'failed', 'test-2', 'trace-extract')
      fs.mkdirSync(traceDir, { recursive: true })
      fs.writeFileSync(path.join(traceDir, 'failure-summary.md'), '# curated trace\n')
      fs.writeFileSync(path.join(runDir, 'failed', 'test-2', 'error.txt'), 'AssertionError: boom\n')

      const ok = await client.callTool({
        name: 'get_failure_detail',
        arguments: { runId: 'failure-detail', failureId: 'test-2' },
      })
      const okBody = JSON.parse(toolText(ok))
      expect(okBody).toMatchObject({
        runId: 'failure-detail',
        failureId: 'test-2',
        name: 'test-2',
        location: 'e2e/example.spec.ts:10',
        errorPath: 'failed/test-2/error.txt',
        traceDir,
        traceSummaryMarkdown: '# curated trace\n',
        errorText: 'AssertionError: boom\n',
      })

      const missing = await client.callTool({
        name: 'get_failure_detail',
        arguments: { runId: 'failure-detail', failureId: 'no-such-test' },
      })
      expect(missing.isError).toBe(true)
      expect(toolText(missing)).toContain('failure not found')
    } finally {
      if (client) await client.close().catch(() => undefined)
      await app.close()
    }
  })

  it('signal_run writes canonical restart/rerun journal payloads', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-signal-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address)

      runStore.bootstrap({
        runId: 'journal-run',
        feature: 'demo_catalog',
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

      const signalBody = JSON.parse(toolText(result)) as { nextSteps?: string[]; runId?: string }
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
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
    const logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-signal-validation-')))
    const { app, runStore } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    let client: Client | null = null
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      client = await connectClient(address)

      runStore.bootstrap({
        runId: 'journal-run',
        feature: 'demo_catalog',
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
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'project')
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
})
