import type { WorkspaceEvent } from '../../../../../../shared/workspace-events'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify from 'fastify'
import { evaluationRoutes } from './evaluation'
import { RunStore } from '../../runs/logic/run-store'
import { createRegistry } from '../../runs/logic/run-registry'
import { createEvaluationExportTask, evaluationExportsDir, patchEvaluationExportTask, readEvaluationExportTask, writeEvaluationExportZip } from '../logic/evaluation-export-store'

import { resolveManifestSessionRef, loadAgentSession } from '../../agent-sessions/logic/agent-session-log'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { manifestWriterFor } from '../../runs/logic/__fixtures__/run-manifest'
import { captureEvents } from '../../../shared/__fixtures__/workspace-events'

const tempDir = trackTempDirs('cl-evalroutes-')

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
  tmpDir = tempDir()
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
})

const writeManifestForRun = manifestWriterFor(() => ({ logsDir, featuresDir }))

async function build(opts: {
  projectRoot?: string
  generateEvaluationRewrite?: Parameters<typeof evaluationRoutes>[1]['generateEvaluationRewrite']
  events?: WorkspaceEvent[]
} = {}) {
  const registry = createRegistry()
  const store = new RunStore(logsDir, registry)
  const app = Fastify()
  await app.register(evaluationRoutes, {
    featuresDir,
    projectRoot: opts.projectRoot,
    store,
    generateEvaluationRewrite: opts.generateEvaluationRewrite,
    workspaceEvents: opts.events ? captureEvents(opts.events) : undefined,
  })
  return { app, registry, store }
}

describe('startEvaluationExportTask race conditions', () => {
  it('skips publishWorkspaceEvent in onSession when patchEvaluationExportTask returns null (onSession false branch)', async () => {
    writeManifestForRun('r-race-session', 'checkout', 'passed')
    const events: WorkspaceEvent[] = []
    vi.mocked(patchEvaluationExportTask).mockReturnValueOnce(null)
    // generateEvaluationRewrite invokes onSession synchronously then returns
    const generateEvaluationRewrite = vi.fn(async (_d, _a, _r, opts) => {
      opts?.onSession?.({ agent: 'claude', sessionId: 'sid-test' })
      return null
    })
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite, events })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-race-session/evaluation-export',
      payload: { mode: 'localized' },
    })
    expect(started.statusCode).toBe(202)
    await new Promise((r) => setTimeout(r, 50))

    const sessionPatchedEvents = events.filter((e) => e.type === 'evaluation-export-updated' &&
      (e as { task?: { sessionRef?: unknown } }).task?.sessionRef !== undefined)
    expect(sessionPatchedEvents).toHaveLength(0)
  })

  it('returns early when readEvaluationExportTask returns null after buildEvaluationZip (line 157+1 true branch)', async () => {
    writeManifestForRun('r-race-deleted', 'checkout', 'passed')
    vi.mocked(readEvaluationExportTask).mockReturnValueOnce(null)
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite: async () => null })

    const started = await app.inject({
      method: 'POST',
      url: '/api/runs/r-race-deleted/evaluation-export',
      payload: { mode: 'localized' },
    })
    expect(started.statusCode).toBe(202)
    await new Promise((r) => setTimeout(r, 50))
  })

  it('skips publishWorkspaceEvent on success when patchEvaluationExportTask returns null (success false branch)', async () => {
    writeManifestForRun('r-race-success', 'checkout', 'passed')
    vi.mocked(patchEvaluationExportTask).mockReturnValueOnce(null)
    const events: WorkspaceEvent[] = []
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite: async () => null, events })

    await app.inject({
      method: 'POST',
      url: '/api/runs/r-race-success/evaluation-export',
      payload: { mode: 'localized' },
    })
    await new Promise((r) => setTimeout(r, 50))

    const completedEvents = events.filter((e) => e.type === 'evaluation-export-updated' &&
      (e as { task?: { status?: string } }).task?.status === 'completed')
    expect(completedEvents).toHaveLength(0)
  })

  it('skips publishWorkspaceEvent on error when patchEvaluationExportTask returns null (error false branch)', async () => {
    writeManifestForRun('r-race-error', 'checkout', 'passed')
    vi.mocked(patchEvaluationExportTask).mockReturnValueOnce(null)
    const events: WorkspaceEvent[] = []
    const { app } = await build({ projectRoot: tmpDir, generateEvaluationRewrite: async () => { throw new Error('forced') }, events })

    await app.inject({
      method: 'POST',
      url: '/api/runs/r-race-error/evaluation-export',
      payload: { mode: 'localized' },
    })
    await new Promise((r) => setTimeout(r, 50))

    const failedEvents = events.filter((e) => e.type === 'evaluation-export-updated' &&
      (e as { task?: { status?: string } }).task?.status === 'failed')
    expect(failedEvents).toHaveLength(0)
  })
})

describe('GET /api/evaluation-exports/:taskId/agent-session', () => {
  it('returns 404 with reason no-session-ref when resolveManifestSessionRef returns null (line 243 true branch)', async () => {
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-agent-nosess',
      runId: 'r-agent-nosess',
      feature: 'checkout',
      mode: 'localized',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: true,
      archiveBase: 'canary-lab-evaluation-checkout-r-agent-nosess',
      sessionRef: { agent: 'claude', sessionId: 'sid-nosess' },
    })
    vi.mocked(resolveManifestSessionRef).mockReturnValueOnce(null)
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/evaluation-exports/eval-agent-nosess/agent-session' })

    expect(res.statusCode).toBe(404)
    expect(res.json().reason).toBe('no-session-ref')
  })

  it('returns 404 with reason session-log-missing when logPath does not exist (line 247 false branch)', async () => {
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-agent-nolog',
      runId: 'r-agent-nolog',
      feature: 'checkout',
      mode: 'localized',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: true,
      archiveBase: 'canary-lab-evaluation-checkout-r-agent-nolog',
      sessionRef: { agent: 'claude', sessionId: 'sid-nolog' },
    })
    vi.mocked(resolveManifestSessionRef).mockReturnValueOnce({
      agent: 'claude',
      sessionId: 'sid-nolog',
      logPath: path.join(tmpDir, 'nonexistent-session.jsonl'),
    })
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/evaluation-exports/eval-agent-nolog/agent-session' })

    expect(res.statusCode).toBe(404)
    expect(res.json().reason).toBe('session-log-missing')
  })

  it('returns agent session data when logPath exists (line 247 true branch)', async () => {
    createEvaluationExportTask(logsDir, {
      taskId: 'eval-agent-ok',
      runId: 'r-agent-ok',
      feature: 'checkout',
      mode: 'localized',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: true,
      archiveBase: 'canary-lab-evaluation-checkout-r-agent-ok',
      sessionRef: { agent: 'claude', sessionId: 'sid-ok' },
    })
    const logPath = path.join(tmpDir, 'session-ok.jsonl')
    fs.writeFileSync(logPath, '')
    vi.mocked(resolveManifestSessionRef).mockReturnValueOnce({
      agent: 'claude',
      sessionId: 'sid-ok',
      logPath,
    })
    vi.mocked(loadAgentSession).mockReturnValueOnce({ events: [], meta: { model: 'claude-3', effort: 'high' } })
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/evaluation-exports/eval-agent-ok/agent-session' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ agent: 'claude', sessionId: 'sid-ok' })
  })
})
