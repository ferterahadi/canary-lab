import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
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

async function waitForEvaluationTask(app: Awaited<ReturnType<typeof build>>['app'], taskId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await app.inject({ method: 'GET', url: `/api/evaluation-exports/${encodeURIComponent(taskId)}` })
    const body = res.json()
    if (body.status !== 'running') return body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`evaluation export task ${taskId} did not finish`)
}

describe('GET /api/runs/:runId/evaluation.html', () => {
  it('dismisses completed evaluation export tasks', async () => {
    writeManifestForRun('r-task-dismiss', 'checkout', 'passed')
    const { app } = await build()

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-dismiss/evaluation-export',
      payload: { mode: 'raw' },
    })
    const task = await waitForEvaluationTask(app, started.json().taskId)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/evaluation-exports/${encodeURIComponent(task.taskId)}`,
    })
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/evaluation-exports/${encodeURIComponent(task.taskId)}`,
    })

    expect(deleted.statusCode).toBe(204)
    expect(fetched.statusCode).toBe(404)
  })

  // The dismissal cases above build without a publisher, so the store bridge
  // installs nothing and the delete announces itself to no one. A client that
  // never hears `evaluation-export-deleted` keeps rendering a task whose files
  // are gone — the same class of staleness the bridge exists to prevent, and the
  // only one of its three mappers no case reached.
  it('announces a deleted export so an open client drops it', async () => {
    writeManifestForRun('r-task-deleted', 'checkout', 'passed')
    const events: WorkspaceEvent[] = []
    const { app } = await build({ events })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-deleted/evaluation-export',
      payload: { mode: 'raw' },
    })
    const task = await waitForEvaluationTask(app, started.json().taskId)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/evaluation-exports/${encodeURIComponent(task.taskId)}`,
    })

    expect(deleted.statusCode).toBe(204)
    expect(events).toContainEqual({ type: 'evaluation-export-deleted', taskId: task.taskId })
  })

  it('deletes a task that was never in the active map (active === undefined branch)', async () => {
    const { app } = await build()
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-no-active-map',
      runId: 'r-no-active',
      feature: 'checkout',
      mode: 'raw',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: true,
      archiveBase: 'canary-lab-evaluation-checkout-r-no-active',
    })
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/evaluation-exports/${encodeURIComponent('eval-no-active-map')}`,
    })
    expect(deleted.statusCode).toBe(204)
  })

  it('calls markExit(0) when active task exists but disk status is not running (ternary false branch)', async () => {
    writeManifestForRun('r-task-exitmode', 'checkout', 'passed')
    const testAbort = new AbortController()
    const generateEvaluationRewrite = vi.fn((_detail, _adapter, _projectRoot, options) => new Promise<null>((resolve) => {
      options?.signal?.addEventListener('abort', () => resolve(null), { once: true })
      testAbort.signal.addEventListener('abort', () => resolve(null), { once: true })
    }))
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite })
    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-exitmode/evaluation-export',
      payload: { mode: 'localized' },
    })
    const taskId = started.json().taskId
    // Spoof readEvaluationExportTask to return status='completed' while the task is still in
    // activeEvaluationExports — exercises: if (active !== undefined) body with ternary=false path.
    vi.mocked(readEvaluationExportTask).mockReturnValueOnce({
      taskId,
      runId: 'r-task-exitmode',
      feature: 'checkout',
      mode: 'localized',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: true,
      archiveBase: 'canary-lab-evaluation-checkout-r-task-exitmode',
    })
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/evaluation-exports/${encodeURIComponent(taskId)}`,
    })
    testAbort.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deleted.statusCode).toBe(204)
  })

  it('cancels running evaluation export tasks when dismissed', async () => {
    writeManifestForRun('r-task-cancel', 'checkout', 'passed')
    let aborted = false
    const generateEvaluationRewrite = vi.fn((_detail, _adapter, _projectRoot, options) => new Promise<null>((resolve) => {
      options?.signal?.addEventListener('abort', () => {
        aborted = true
        resolve(null)
      }, { once: true })
    }))
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-cancel/evaluation-export',
      payload: { mode: 'localized' },
    })
    const taskId = started.json().taskId
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/evaluation-exports/${encodeURIComponent(taskId)}`,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/evaluation-exports/${encodeURIComponent(taskId)}`,
    })

    expect(deleted.statusCode).toBe(204)
    expect(aborted).toBe(true)
    expect(fetched.statusCode).toBe(404)
  })

  it('exposes failed evaluation export tasks with an error', async () => {
    writeManifestForRun('r-task-failed', 'checkout', 'passed')
    const artifactsDir = path.join(runDirFor(logsDir, 'r-task-failed'), 'playwright-artifacts')
    fs.mkdirSync(artifactsDir, { recursive: true })
    const unreadableVideo = path.join(artifactsDir, 'blocked.webm')
    fs.writeFileSync(unreadableVideo, 'video')
    fs.chmodSync(unreadableVideo, 0)
    const { app } = await build()

    try {
      const started = await app.inject({
        method: 'POST',
        url: '/api/runs/r-task-failed/evaluation-export',
        payload: { mode: 'raw' },
      })

      const task = await waitForEvaluationTask(app, started.json().taskId)
      expect(task.status).toBe('failed')
      expect(task.downloadReady).toBe(false)
      expect(task.error).toBeTruthy()
    } finally {
      fs.chmodSync(unreadableVideo, 0o644)
    }
  })

  it('rejects evaluation export task requests for missing, active, or invalid-mode runs', async () => {
    writeManifestForRun('r-active-task', 'checkout', 'running')
    const { app } = await build()

    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/missing/evaluation-export',
      payload: { mode: 'raw' },
    })).statusCode).toBe(404)
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/r-active-task/evaluation-export',
      payload: { mode: 'raw' },
    })).statusCode).toBe(409)
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/runs/r-active-task/evaluation-export',
      payload: { mode: 'invalid' },
    })
    expect(invalid.statusCode).toBe(409)

    writeManifestForRun('r-invalid-mode', 'checkout', 'passed')
    const invalidMode = await app.inject({
      method: 'POST',
      url: '/api/runs/r-invalid-mode/evaluation-export',
      payload: { mode: 'invalid' },
    })
    expect(invalidMode.statusCode).toBe(400)
  })

  it('returns not found for unknown evaluation export tasks', async () => {
    const { app } = await build()

    expect((await app.inject({ method: 'GET', url: '/api/evaluation-exports/missing' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/evaluation-exports/missing/download' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/api/evaluation-exports/missing' })).statusCode).toBe(404)
  })

  it('marks persisted running evaluation export tasks as failed when no worker owns them', async () => {
    const events: WorkspaceEvent[] = []
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-stale-task',
      runId: 'r-stale-task',
      feature: 'checkout',
      mode: 'raw',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: false,
      archiveBase: 'canary-lab-evaluation-checkout-r-stale-task',
    })
    const { app } = await build({ events })

    const listed = await app.inject({ method: 'GET', url: '/api/evaluation-exports' })
    const fetched = await app.inject({ method: 'GET', url: '/api/evaluation-exports/eval-stale-task' })

    expect(listed.json()[0]).toMatchObject({
      taskId: 'eval-stale-task',
      status: 'failed',
      downloadReady: false,
      error: 'evaluation export interrupted; start a new export',
    })
    expect(fetched.json()).toMatchObject({ status: 'failed' })
    expect(fs.readFileSync(path.join(evaluationExportsDir(logsDir), 'eval-stale-task', 'export.log'), 'utf8')).toContain('interrupted')
    expect(events).toContainEqual(expect.objectContaining({
      type: 'evaluation-export-updated',
      task: expect.objectContaining({ taskId: 'eval-stale-task', status: 'failed' }),
    }))
  })

  it('keeps running external evaluation export tasks pending across refresh', async () => {
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-external-pending',
      runId: 'r-external-pending',
      feature: 'checkout',
      mode: 'localized',
      producer: 'external',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: false,
      archiveBase: 'canary-lab-evaluation-checkout-r-external-pending',
      clientKind: 'codex',
      sessionId: 'sess-export',
      conversationName: 'Export evaluation',
      language: 'English',
    })
    const { app } = await build()

    const listed = await app.inject({ method: 'GET', url: '/api/evaluation-exports' })
    const fetched = await app.inject({ method: 'GET', url: '/api/evaluation-exports/eval-external-pending' })

    expect(listed.json()[0]).toMatchObject({
      taskId: 'eval-external-pending',
      producer: 'external',
      status: 'running',
      downloadReady: false,
      clientKind: 'codex',
      sessionId: 'sess-export',
    })
    expect(fetched.json()).toMatchObject({ status: 'running', producer: 'external' })
  })

  it('completes localized tasks with fallback wording when no rewrite is generated', async () => {
    writeManifestForRun('!!!', '???', 'passed')
    const { app } = await build({
      projectRoot: tmpDir,
      generateEvaluationRewrite: async () => null,
    })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/!!!/evaluation-export',
      payload: { mode: 'localized' },
    })
    const task = await waitForEvaluationTask(app, started.json().taskId)
    const download = await app.inject({
      method: 'GET',
      url: `/api/evaluation-exports/${encodeURIComponent(task.taskId)}/download`,
    })

    expect(task.status).toBe('completed')
    expect(download.headers['content-disposition']).toContain('canary-lab-evaluation-run-run.zip')
    expect(fs.readFileSync(path.join(runDirFor(logsDir, '!!!'), 'evaluation-rewrite-error.txt'), 'utf-8')).toContain('No evaluation rewrite was generated')
  })

  it('records string failures from localized evaluation export tasks', async () => {
    writeManifestForRun('r-task-string-failed', 'checkout', 'passed')
    const { app } = await build({
      projectRoot: tmpDir,
      generateEvaluationRewrite: async () => { throw 'string failure' },
    })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-task-string-failed/evaluation-export',
      payload: { mode: 'localized' },
    })
    const task = await waitForEvaluationTask(app, started.json().taskId)

    expect(task.status).toBe('completed')
    expect(fs.readFileSync(path.join(runDirFor(logsDir, 'r-task-string-failed'), 'evaluation-rewrite-error.txt'), 'utf-8')).toContain('string failure')
  })

  it('404s when the run is unknown', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/missing/evaluation.html' })
    expect(res.statusCode).toBe(404)
  })

  it('409s while the run is still active', async () => {
    writeManifestForRun('r-active', 'checkout', 'running')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r-active/evaluation.html' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('after the run finishes')
  })
})

describe('GET /api/evaluation-exports/:taskId/agent-session', () => {
  it('404s with task-not-found when the task does not exist', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/evaluation-exports/nonexistent-task/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json().reason).toBe('task-not-found')
  })

  it('404s with no-session-ref when the task has no sessionRef', async () => {
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-task-nosess',
      runId: 'r1',
      feature: 'foo',
      mode: 'raw',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: false,
      archiveBase: 'archive',
    })
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/evaluation-exports/eval-task-nosess/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json().reason).toBe('no-session-ref')
  })

  it('404s with no-session-ref when the task has a claude sessionRef but the log cannot be found', async () => {
    // resolveManifestSessionRef for 'claude' calls findClaudeLogBySessionId, which returns null
    // when the session isn't in ~/.claude/projects/ — so the route returns no-session-ref.
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-task-nolog',
      runId: 'r1',
      feature: 'foo',
      mode: 'localized',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: false,
      archiveBase: 'archive',
      sessionRef: { agent: 'claude', sessionId: 'sess-unknown-xyz' },
    })
    const { app } = await build({ projectRoot: tmpDir })
    const res = await app.inject({ method: 'GET', url: '/api/evaluation-exports/eval-task-nolog/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json().reason).toBe('no-session-ref')
  })
})
