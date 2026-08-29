import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import WebSocket from 'ws'
import { evaluationRoutes } from './evaluation'
import { createRegistry, RunStore } from '../../runs/logic/run-store'
import { bridgeEvaluationExportEvents, createEvaluationExportTask, evaluationExportsDir, patchEvaluationExportTask, readEvaluationExportTask, writeEvaluationExportZip } from '../logic/evaluation-export-store'
import { writeManifest } from '../../runs/logic/runtime/manifest'
import { runDirFor } from '../../runs/logic/runtime/run-paths'
import type { WorkspaceEvent } from '../../../shared/workspace-events'
import { resolveManifestSessionRef, loadAgentSession } from '../../agent-sessions/logic/agent-session-log'

vi.mock('../logic/evaluation-export-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../logic/evaluation-export-store')>()
  return {
    ...original,
    patchEvaluationExportTask: vi.fn(original.patchEvaluationExportTask),
    readEvaluationExportTask: vi.fn(original.readEvaluationExportTask),
    writeEvaluationExportZip: vi.fn(original.writeEvaluationExportZip),
  }
})

vi.mock('../../agent-sessions/logic/agent-session-log', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../agent-sessions/logic/agent-session-log')>()
  return {
    ...original,
    resolveManifestSessionRef: vi.fn(original.resolveManifestSessionRef),
    loadAgentSession: vi.fn(original.loadAgentSession),
  }
})

let tmpDir: string

let logsDir: string

let featuresDir: string

beforeEach(() => {
  vi.mocked(patchEvaluationExportTask).mockClear()
  vi.mocked(readEvaluationExportTask).mockClear()
  vi.mocked(writeEvaluationExportZip).mockClear()
  vi.mocked(resolveManifestSessionRef).mockClear()
  vi.mocked(loadAgentSession).mockClear()
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-evalroutes-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
})

function writeManifestForRun(runId: string, feature = 'foo', status: 'running' | 'passed' | 'failed' | 'healing' | 'aborted' = 'passed'): void {
  const dir = runDirFor(logsDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(path.join(dir, 'manifest.json'), {
    runId,
    feature,
    featureDir: path.join(featuresDir, feature),
    startedAt: 'now',
    status,
    healCycles: 0,
    services: [],
  })
}

async function build(opts: {
  projectRoot?: string
  generateEvaluationRewrite?: Parameters<typeof evaluationRoutes>[1]['generateEvaluationRewrite']
  events?: WorkspaceEvent[]
} = {}) {
  const registry = createRegistry()
  const store = new RunStore(logsDir, registry)
  const app = Fastify()
  // An export task announces itself from the STORE now
  // (bridgeEvaluationExportEvents, wired once at boot in server.ts) — the app
  // under test gets the same bridge, because the routes no longer publish.
  bridgeEvaluationExportEvents(logsDir, opts.events ? { publish: (event) => opts.events!.push(event) } : undefined)
  await app.register(evaluationRoutes, {
    featuresDir,
    projectRoot: opts.projectRoot,
    store,
    generateEvaluationRewrite: opts.generateEvaluationRewrite,
    workspaceEvents: opts.events ? { publish: (event) => opts.events!.push(event) } : undefined,
  })
  return { app, registry, store }
}

async function buildWithWs(opts: Parameters<typeof build>[0] = {}) {
  const registry = createRegistry()
  const store = new RunStore(logsDir, registry)
  const app = Fastify()
  // An export task announces itself from the STORE now
  // (bridgeEvaluationExportEvents, wired once at boot in server.ts) — the app
  // under test gets the same bridge, because the routes no longer publish.
  bridgeEvaluationExportEvents(logsDir, opts.events ? { publish: (event) => opts.events!.push(event) } : undefined)
  await app.register(fastifyWebsocket)
  await app.register(evaluationRoutes, {
    featuresDir,
    projectRoot: opts.projectRoot,
    store,
    generateEvaluationRewrite: opts.generateEvaluationRewrite,
    workspaceEvents: opts.events ? { publish: (event) => opts.events!.push(event) } : undefined,
  })
  return { app, registry, store }
}

function collectWsMessages(ws: WebSocket, timeout = 2000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const msgs: unknown[] = []
    const timer = setTimeout(() => resolve(msgs), timeout)
    ws.on('message', (data) => { msgs.push(JSON.parse(data.toString())) })
    ws.on('close', () => { clearTimeout(timer); resolve(msgs) })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

async function waitForEvaluationTask(app: Awaited<ReturnType<typeof build>>['app'], taskId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await app.inject({ method: 'GET', url: `/api/evaluation-exports/${encodeURIComponent(taskId)}` })
    const body = res.json()
    if (body.status !== 'running') return body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`evaluation export task ${taskId} did not finish`)
}

describe('loadEvaluationRewrite — onSession and cache branches', () => {
  it('fires onSession callback when the generate function calls it (patches task sessionRef)', async () => {
    writeManifestForRun('r-onsession', 'checkout', 'passed')
    const events: WorkspaceEvent[] = []
    const generateEvaluationRewrite = vi.fn(
      async (_detail: unknown, _adapter: unknown, _projectRoot: unknown, options?: { onSession?: (s: { agent: 'claude' | 'codex'; sessionId: string }) => void }) => {
        options?.onSession?.({ agent: 'claude', sessionId: 'sess-onession-xyz' })
        return null
      },
    )
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite, events })

    const started = await app.inject({
      method: 'POST', url: '/api/runs/r-onsession/evaluation-export', payload: { mode: 'localized' },
    })
    await waitForEvaluationTask(app, started.json().taskId)

    const task = await app.inject({ method: 'GET', url: `/api/evaluation-exports/${encodeURIComponent(started.json().taskId)}` })
    // The onSession callback patched the task's sessionRef
    expect(task.json().sessionRef).toEqual({ agent: 'claude', sessionId: 'sess-onession-xyz' })
    // An evaluation-export-updated workspace event fired with the patched sessionRef
    expect(events.some(
      (e) => e.type === 'evaluation-export-updated' && (e as { task: { sessionRef?: { sessionId: string } } }).task.sessionRef?.sessionId === 'sess-onession-xyz',
    )).toBe(true)
  })

  it('reuses cached localized wording on a second export for the same run (if(cached) true branch)', async () => {
    writeManifestForRun('r-cache-reuse', 'checkout', 'passed')
    let callCount = 0
    const generateEvaluationRewrite = vi.fn(async () => {
      callCount += 1
      return {
        featureTitle: 'Cached',
        summary: 'Cached summary.',
        cases: [{ title: 'C', whatWasChecked: 'W', whyItMatters: 'M', confidence: 'H' }],
      }
    })
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite })

    // First export — generate is called and result is cached.
    const first = await app.inject({ method: 'POST', url: '/api/runs/r-cache-reuse/evaluation-export', payload: { mode: 'localized' } })
    await waitForEvaluationTask(app, first.json().taskId)
    expect(callCount).toBe(1)

    // Second export — readCachedEvaluationRewrite finds the file; generate is NOT called again.
    const second = await app.inject({ method: 'POST', url: '/api/runs/r-cache-reuse/evaluation-export', payload: { mode: 'localized' } })
    await waitForEvaluationTask(app, second.json().taskId)
    expect(callCount).toBe(1) // generate was only called once
  })

  it('ignores a cached file whose formatVersion is wrong and regenerates (readCachedEvaluationRewrite returns undefined)', async () => {
    writeManifestForRun('r-bad-version', 'checkout', 'passed')
    // Pre-write an evaluation-rewrite.json with wrong formatVersion (0 ≠ current).
    const runDir = runDirFor(logsDir, 'r-bad-version')
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      path.join(runDir, 'evaluation-rewrite.json'),
      JSON.stringify({ formatVersion: 0, featureTitle: 'Stale', summary: 'stale', cases: [] }),
    )
    let called = false
    const generateEvaluationRewrite = vi.fn(async () => {
      called = true
      return null  // returning null is fine — tests the branch was reached
    })
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite })

    const started = await app.inject({ method: 'POST', url: '/api/runs/r-bad-version/evaluation-export', payload: { mode: 'localized' } })
    const task = await waitForEvaluationTask(app, started.json().taskId)

    // stale cache was ignored; generator was called (covers readCachedEvaluationRewrite returning undefined)
    expect(called).toBe(true)
    expect(task.status).toBe('completed')
  })
})

describe('WS /ws/evaluation-exports/:taskId', () => {
  let serverAddress: string

  afterEach(async () => {
    serverAddress = ''
  })

  it('sends an error and closes when the task does not exist (task-not-found branch)', async () => {
    const { app } = await buildWithWs()
    serverAddress = await app.listen({ port: 0, host: '127.0.0.1' })
    try {
      const wsUrl = `ws://127.0.0.1:${new URL(serverAddress).port}/ws/evaluation-exports/no-such-task`
      const ws = new WebSocket(wsUrl)
      const msgs = await collectWsMessages(ws)
      expect(msgs).toContainEqual(expect.objectContaining({ type: 'error' }))
    } finally {
      await app.close()
    }
  })

  it('sends log data and exit(0) for a completed task (no active, log present)', async () => {
    const { app } = await buildWithWs()
    // Create a completed export task with an existing log.
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-ws-completed',
      runId: 'r-ws',
      feature: 'checkout',
      mode: 'raw',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: true,
      archiveBase: 'base',
    })
    // Write a log file so log.length > 0.
    const exportDir = path.join(evaluationExportsDir(logsDir), 'eval-ws-completed')
    fs.mkdirSync(exportDir, { recursive: true })
    fs.writeFileSync(path.join(exportDir, 'export.log'), '[evaluation] task completed\n')

    serverAddress = await app.listen({ port: 0, host: '127.0.0.1' })
    try {
      const wsUrl = `ws://127.0.0.1:${new URL(serverAddress).port}/ws/evaluation-exports/eval-ws-completed`
      const ws = new WebSocket(wsUrl)
      const msgs = await collectWsMessages(ws)
      expect(msgs.some((m) => (m as { type: string }).type === 'data')).toBe(true)
      expect(msgs.some((m) => (m as { type: string; code: number }).type === 'exit' && (m as { type: string; code: number }).code === 0)).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('sends exit(1) for a failed task with no log (log.length = 0 false branch, exit code 1)', async () => {
    const { app } = await buildWithWs()
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-ws-failed',
      runId: 'r-ws-failed',
      feature: 'checkout',
      mode: 'raw',
      status: 'failed',
      error: 'oops',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: false,
      archiveBase: 'base',
    })
    // No log file → log.length === 0.
    serverAddress = await app.listen({ port: 0, host: '127.0.0.1' })
    try {
      const wsUrl = `ws://127.0.0.1:${new URL(serverAddress).port}/ws/evaluation-exports/eval-ws-failed`
      const ws = new WebSocket(wsUrl)
      const msgs = await collectWsMessages(ws)
      expect(msgs.some((m) => (m as { type: string; code: number }).type === 'exit' && (m as { type: string; code: number }).code === 1)).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('subscribes to live output when a task is still running (active broker path)', async () => {
    writeManifestForRun('r-ws-running', 'checkout', 'passed')
    let resolveGen: (v: null) => void
    const generateEvaluationRewrite = vi.fn(
      () => new Promise<null>((res) => { resolveGen = res }),
    )
    const { app } = await buildWithWs({ projectRoot: tmpDir, generateEvaluationRewrite })

    const started = await app.inject({
      method: 'POST', url: '/api/runs/r-ws-running/evaluation-export', payload: { mode: 'localized' },
    })
    const taskId = started.json().taskId

    serverAddress = await app.listen({ port: 0, host: '127.0.0.1' })
    try {
      const wsUrl = `ws://127.0.0.1:${new URL(serverAddress).port}/ws/evaluation-exports/${encodeURIComponent(taskId)}`
      const ws = new WebSocket(wsUrl)

      // Wait for WS to open, then let the generator resolve so the task completes.
      await new Promise<void>((res) => ws.on('open', () => res()))
      resolveGen!(null)

      const msgs = await collectWsMessages(ws)
      // The WS receives at least one message (data or exit) from the active broker.
      expect(msgs.length).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })
})

describe('evaluation rewrite write-helper catch blocks', () => {
  it('swallows EISDIR on writeCachedEvaluationRewrite when evaluation-rewrite.json is a directory', async () => {
    writeManifestForRun('r-eisdir-cached', 'checkout', 'passed')
    const runDir = runDirFor(logsDir, 'r-eisdir-cached')
    // Block writeCachedEvaluationRewrite: target path is a directory, so writeFileSync throws EISDIR
    fs.mkdirSync(path.join(runDir, 'evaluation-rewrite.json'), { recursive: true })

    const { app } = await build({
      projectRoot: tmpDir,
      generateEvaluationRewrite: async () => ({
        featureTitle: 'Checkout',
        summary: 'Summary.',
        cases: [{ title: 'Case', whatWasChecked: 'Check.', whyItMatters: 'Impact.', confidence: 'High.' }],
      }),
    })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-eisdir-cached/evaluation-export',
      payload: { mode: 'localized' },
    })
    expect(started.statusCode).toBe(202)
    const task = await waitForEvaluationTask(app, started.json().taskId)
    expect(task.status).toBe('completed')
  })

  it('swallows EISDIR on writeEvaluationRewriteError when evaluation-rewrite-error.txt is a directory', async () => {
    writeManifestForRun('r-eisdir-error', 'checkout', 'passed')
    const runDir = runDirFor(logsDir, 'r-eisdir-error')
    // Block writeEvaluationRewriteError: target path is a directory, so writeFileSync throws EISDIR
    fs.mkdirSync(path.join(runDir, 'evaluation-rewrite-error.txt'), { recursive: true })

    const { app } = await build({
      projectRoot: tmpDir,
      generateEvaluationRewrite: async () => { throw new Error('forced rewrite error') },
    })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-eisdir-error/evaluation-export',
      payload: { mode: 'localized' },
    })
    expect(started.statusCode).toBe(202)
    const task = await waitForEvaluationTask(app, started.json().taskId)
    expect(task.status).toBe('completed')
  })

  it('swallows EISDIR on clearEvaluationRewriteError when evaluation-rewrite-error.txt is a non-empty directory', async () => {
    writeManifestForRun('r-eisdir-clear', 'checkout', 'passed')
    const runDir = runDirFor(logsDir, 'r-eisdir-clear')
    // Block clearEvaluationRewriteError: rmSync on a non-empty directory (without recursive) throws EISDIR/ENOTEMPTY
    const errorDir = path.join(runDir, 'evaluation-rewrite-error.txt')
    fs.mkdirSync(errorDir, { recursive: true })
    fs.writeFileSync(path.join(errorDir, 'keep'), '')

    const { app } = await build({
      projectRoot: tmpDir,
      generateEvaluationRewrite: async () => ({
        featureTitle: 'Checkout',
        summary: 'Summary.',
        cases: [{ title: 'Case', whatWasChecked: 'Check.', whyItMatters: 'Impact.', confidence: 'High.' }],
      }),
    })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-eisdir-clear/evaluation-export',
      payload: { mode: 'localized' },
    })
    expect(started.statusCode).toBe(202)
    const task = await waitForEvaluationTask(app, started.json().taskId)
    expect(task.status).toBe('completed')
  })
})

describe('startEvaluationExportTask — non-Error thrown in try block (line 172 false branch)', () => {
  it('uses String(err) when writeEvaluationExportZip throws a non-Error string value', async () => {
    writeManifestForRun('r-string-throw', 'checkout', 'passed')
    vi.mocked(writeEvaluationExportZip).mockImplementationOnce(() => { throw 'zip-write-failed' })
    const { app } = await build()

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-string-throw/evaluation-export',
      payload: { mode: 'raw' },
    })
    expect(started.statusCode).toBe(202)
    const task = await waitForEvaluationTask(app, started.json().taskId)

    expect(task.status).toBe('failed')
    expect(task.error).toBe('zip-write-failed')
  })
})

describe('recoverStaleEvaluationExports race condition — patchEvaluationExportTask returns null', () => {
  it('skips publishWorkspaceEvent when patchEvaluationExportTask returns null (line 114 false branch)', async () => {
    const events: WorkspaceEvent[] = []
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-race-patch',
      runId: 'r-race-patch',
      feature: 'checkout',
      mode: 'raw',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: false,
      archiveBase: 'canary-lab-evaluation-checkout-r-race-patch',
    })
    vi.mocked(patchEvaluationExportTask).mockReturnValueOnce(null)
    const { app } = await build({ events })

    await app.inject({ method: 'GET', url: '/api/evaluation-exports' })

    expect(events.filter((e) => e.type === 'evaluation-export-updated')).toHaveLength(0)
  })
})

// Which voice writes the report is decided from the project's `healAgent`.
// The retired `external` value once mapped straight to `deterministic`, so a
// default workspace's "Localized output" handed back raw wording and said
// nothing about it. Since 2.2.0 the value itself migrates to `claude` on load,
// which resolves the same silent symptom one level earlier. These pin the
// mapping, because the symptom is silent: you get a report either way, just
// not the one you asked for.
describe('localized export — which voice writes the report', () => {
  const writeConfig = (root: string, healAgent: string) => {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'canary-lab.config.json'), JSON.stringify({ healAgent }))
  }

  /** Runs a localized export and returns the audienceAdapter the route chose. */
  async function adapterFor(healAgent: string, runId: string): Promise<unknown> {
    const projectRoot = path.join(tmpDir, `proj-${healAgent}`)
    writeConfig(projectRoot, healAgent)
    writeManifestForRun(runId, 'checkout', 'passed')
    const seen: unknown[] = []
    const { app } = await build({
      projectRoot,
      generateEvaluationRewrite: vi.fn(async (_detail: unknown, adapter: unknown) => {
        seen.push(adapter)
        return null
      }),
    })
    const started = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/evaluation-export`,
      payload: { mode: 'localized' },
    })
    expect(started.statusCode).toBe(202)
    await waitForEvaluationTask(app, started.json().taskId)
    return seen[0]
  }

  it('speaks as claude when the config still stores the retired `external` value', async () => {
    // NOT 'deterministic': the stored `external` migrates to `claude` on load
    // (2.2.0), so a 2.1.x workspace's localized export gets a real voice
    // instead of quietly shipping raw wording.
    expect(await adapterFor('external', 'r-adapter-external')).toBe('claude')
  })

  it('lets the resolver look for any local CLI when the project is set to auto', async () => {
    // `auto` says nothing about which CLI is on the machine; only a machine
    // with neither CLI falls back to raw wording, and that is a fact about the
    // machine.
    expect(await adapterFor('auto', 'r-adapter-auto')).toBe('auto')
  })

  it('honours an explicitly configured agent', async () => {
    expect(await adapterFor('claude', 'r-adapter-claude')).toBe('claude')
  })

  it('says in the export log when no CLI was found, instead of quietly shipping raw wording', async () => {
    const projectRoot = path.join(tmpDir, 'proj-nocli')
    writeConfig(projectRoot, 'external')
    writeManifestForRun('r-adapter-nocli', 'checkout', 'passed')
    const { app } = await build({
      projectRoot,
      generateEvaluationRewrite: vi.fn(async () => null),
    })
    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-adapter-nocli/evaluation-export',
      payload: { mode: 'localized' },
    })
    const taskId = started.json().taskId
    await waitForEvaluationTask(app, taskId)

    const log = fs.readFileSync(path.join(evaluationExportsDir(logsDir), taskId, 'export.log'), 'utf-8')
    expect(log).toContain('no claude or codex CLI available')
    expect(log).toContain('raw wording')
  })
})
