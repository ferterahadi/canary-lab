import type { FastifyInstance, FastifyReply } from 'fastify'
import fs from 'fs'
import path from 'path'
import type { RunDetail, RunStore } from '../../runs/logic/run-store'
import { runDirFor } from '../../runs/logic/runtime/run-paths'
import { loadProjectConfig } from '../../runs/logic/runtime/launcher/project-config'
import { PaneBroker, type PaneSubscriber } from '../../runs/logic/pane-broker'
import { isTerminalRunStatus } from '../../../../../../shared/run-state'
import { loadAgentSession, resolveManifestSessionRef } from '../../agent-sessions/logic/agent-session-log'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { generateEvaluationRewriteWithAgent, type EvaluationRewrite } from '../logic/test-review-export'
import { buildEvaluationExportArchive } from '../logic/evaluation-export-archive'
import {
  appendEvaluationExportLog,
  createEvaluationExportTask,
  deleteEvaluationExportTask,
  evaluationExportTaskView,
  listEvaluationExportTasks,
  patchEvaluationExportTask,
  readEvaluationExportLog,
  readEvaluationExportTask,
  readEvaluationExportZip,
  writeEvaluationExportZip,
  type EvaluationExportMode,
  type EvaluationExportTaskRecord,
} from '../logic/evaluation-export-store'

const EVALUATION_REWRITE_FORMAT_VERSION = 6

interface ActiveEvaluationExportTask {
  broker: PaneBroker
  abortController: AbortController
}

export interface EvaluationRoutesDeps {
  featuresDir: string
  projectRoot?: string
  /** Run state store — evaluation exports a finished run's results, so it reads
   *  run details + the on-disk logs dir through this. */
  store: RunStore
  workspaceEvents?: WorkspaceEventPublisher
  generateEvaluationRewrite?(
    detail: Parameters<typeof generateEvaluationRewriteWithAgent>[0],
    audienceAdapter: Parameters<typeof generateEvaluationRewriteWithAgent>[1],
    projectRoot?: string,
    options?: Parameters<typeof generateEvaluationRewriteWithAgent>[3],
  ): Promise<EvaluationRewrite | null>
}

export async function evaluationRoutes(app: FastifyInstance, deps: EvaluationRoutesDeps): Promise<void> {
  const activeEvaluationExports = new Map<string, ActiveEvaluationExportTask>()

  const buildEvaluationZip = async (
    detail: RunDetail,
    mode: EvaluationExportMode,
    log?: (chunk: string) => void,
    signal?: AbortSignal,
    onSession?: (session: { agent: 'claude' | 'codex'; sessionId: string }) => void,
  ): Promise<{ archiveBase: string; zip: Buffer }> => {
    throwIfAborted(signal)
    log?.(`[evaluation] preparing ${mode === 'raw' ? 'raw output' : 'localized output'} export\n`)
    // When the project default is the new `external` heal-agent, there is no
    // local LLM voice for evaluation rewriting — fall back to the deterministic
    // adapter so exports stay reproducible.
    const projectHealAgent = mode === 'localized' && deps.projectRoot
      ? loadProjectConfig(deps.projectRoot).healAgent
      : 'deterministic'
    const audienceAdapter: 'auto' | 'claude' | 'codex' | 'manual' | 'deterministic' =
      projectHealAgent === 'external' ? 'deterministic' : projectHealAgent
    const runDir = runDirFor(deps.store.logsDir, detail.runId)
    const rewrite = mode === 'localized'
      ? await loadEvaluationRewrite(detail, runDir, audienceAdapter, deps.projectRoot, deps.generateEvaluationRewrite, app.log, log, signal, onSession)
      : undefined
    throwIfAborted(signal)
    const built = await buildEvaluationExportArchive(detail, {
      logsDir: deps.store.logsDir,
      featuresDir: deps.featuresDir,
      audienceAdapter,
      rewrite,
    })
    log?.('[evaluation] export archive ready\n')
    return built
  }

  const sendEvaluationExport = async (runId: string, reply: FastifyReply) => {
    const detail = deps.store.get(runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    if (!isTerminalRunStatus(detail.manifest.status)) {
      reply.code(409)
      return { error: 'evaluation export is available after the run finishes' }
    }
    const { archiveBase, zip } = await buildEvaluationZip(detail, 'localized')
    reply
      .type('application/zip')
      .header('content-disposition', `attachment; filename="${archiveBase}.zip"`)
    return reply.send(zip)
  }

  const recoverStaleEvaluationExports = (): void => {
    const activeIds = new Set(activeEvaluationExports.keys())
    for (const task of listEvaluationExportTasks(deps.store.logsDir)) {
      if (task.status !== 'running' || activeIds.has(task.taskId)) continue
      if ((task.producer ?? 'internal') === 'external') continue
      const message = 'evaluation export interrupted; start a new export'
      appendEvaluationExportLog(deps.store.logsDir, task.taskId, `[evaluation] task failed: ${message}\n`)
      const patched = patchEvaluationExportTask(deps.store.logsDir, task.taskId, {
        status: 'failed',
        downloadReady: false,
        error: message,
      })
      if (patched) {
        publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-updated', task: evaluationExportTaskView(patched) })
      }
    }
  }

  const startEvaluationExportTask = (detail: RunDetail, mode: EvaluationExportMode) => {
    const now = new Date().toISOString()
    const task: EvaluationExportTaskRecord = {
      taskId: `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      runId: detail.runId,
      feature: detail.manifest.feature,
      mode,
      producer: 'internal',
      status: 'running',
      createdAt: now,
      updatedAt: now,
      downloadReady: false,
      archiveBase: `canary-lab-evaluation-${safeFilename(detail.manifest.feature)}-${safeFilename(detail.runId)}`,
    }
    const active: ActiveEvaluationExportTask = {
      broker: new PaneBroker(),
      abortController: new AbortController(),
    }
    createEvaluationExportTask(deps.store.logsDir, task)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-created', task: evaluationExportTaskView(task) })
    activeEvaluationExports.set(task.taskId, active)
    const push = (chunk: string): void => {
      appendEvaluationExportLog(deps.store.logsDir, task.taskId, chunk)
      active.broker.push('export', chunk)
    }
    // Persist the rewrite agent's session ref the moment it's spawned, so the
    // export dialog can swap from the text panel to the live AgentSessionView.
    const onSession = (session: { agent: 'claude' | 'codex'; sessionId: string }): void => {
      const patched = patchEvaluationExportTask(deps.store.logsDir, task.taskId, { sessionRef: session })
      if (patched) {
        publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-updated', task: evaluationExportTaskView(patched) })
      }
    }
    push(`[evaluation] task ${task.taskId} started\n`)
    void (async () => {
      try {
        const built = await buildEvaluationZip(detail, mode, push, active.abortController.signal, onSession)
        if (!readEvaluationExportTask(deps.store.logsDir, task.taskId)) return
        writeEvaluationExportZip(deps.store.logsDir, task.taskId, built.zip)
        const patched = patchEvaluationExportTask(deps.store.logsDir, task.taskId, {
          archiveBase: built.archiveBase,
          status: 'completed',
          downloadReady: true,
        })
        if (patched) {
          publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-updated', task: evaluationExportTaskView(patched) })
        }
        push('[evaluation] task completed\n')
        active.broker.markExit('export', 0)
      } catch (err) {
        if (!readEvaluationExportTask(deps.store.logsDir, task.taskId)) return
        const error = err instanceof Error ? err.message : String(err)
        const patched = patchEvaluationExportTask(deps.store.logsDir, task.taskId, {
          status: 'failed',
          error,
          downloadReady: false,
        })
        if (patched) {
          publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-updated', task: evaluationExportTaskView(patched) })
        }
        push(`[evaluation] task failed: ${error}\n`)
        active.broker.markExit('export', 1)
      } finally {
        activeEvaluationExports.delete(task.taskId)
      }
    })()
    return evaluationExportTaskView(task)
  }

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/evaluation.html', async (req, reply) => {
    return sendEvaluationExport(req.params.runId, reply)
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/assertion.html', async (req, reply) => {
    return sendEvaluationExport(req.params.runId, reply)
  })

  app.post<{ Params: { runId: string }; Body: { mode?: string } }>('/api/runs/:runId/evaluation-export', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    if (!isTerminalRunStatus(detail.manifest.status)) {
      reply.code(409)
      return { error: 'evaluation export is available after the run finishes' }
    }
    const mode = parseEvaluationExportMode(req.body?.mode)
    if (!mode) {
      reply.code(400)
      return { error: 'mode must be "raw" or "localized"' }
    }
    reply.code(202)
    return startEvaluationExportTask(detail, mode)
  })

  app.get<{ Querystring: { runId?: string } }>('/api/evaluation-exports', async (req) => {
    recoverStaleEvaluationExports()
    return listEvaluationExportTasks(deps.store.logsDir, { runId: req.query.runId })
      .map(evaluationExportTaskView)
  })

  app.get<{ Params: { taskId: string } }>('/api/evaluation-exports/:taskId', async (req, reply) => {
    recoverStaleEvaluationExports()
    const task = readEvaluationExportTask(deps.store.logsDir, req.params.taskId)
    if (!task) {
      reply.code(404)
      return { error: 'evaluation export task not found' }
    }
    return evaluationExportTaskView(task)
  })

  // Structured rewrite-agent session for the export dialog's AgentSessionView.
  // Resolves the session ref the localized-rewrite agent pinned on the task
  // (claude by id, codex by project root + start) and parses its JSONL. 404s
  // with a `reason` for every miss so the dialog falls back to the text panel.
  app.get<{ Params: { taskId: string } }>('/api/evaluation-exports/:taskId/agent-session', async (req, reply) => {
    const task = readEvaluationExportTask(deps.store.logsDir, req.params.taskId)
    if (!task) {
      reply.code(404)
      return { reason: 'task-not-found' }
    }
    const ref = resolveManifestSessionRef(task.sessionRef, { projectRoot: deps.projectRoot, startedAt: task.createdAt })
    if (!ref) {
      reply.code(404)
      return { reason: 'no-session-ref' }
    }
    if (!fs.existsSync(ref.logPath)) {
      reply.code(404)
      return { reason: 'session-log-missing' }
    }
    const { events, meta } = loadAgentSession(ref)
    return { agent: ref.agent, sessionId: ref.sessionId, model: meta.model, effort: meta.effort, events }
  })

  app.get<{ Params: { taskId: string } }>('/api/evaluation-exports/:taskId/download', async (req, reply) => {
    recoverStaleEvaluationExports()
    const task = readEvaluationExportTask(deps.store.logsDir, req.params.taskId)
    if (!task) {
      reply.code(404)
      return { error: 'evaluation export task not found' }
    }
    const zip = task.status === 'completed' ? readEvaluationExportZip(deps.store.logsDir, task.taskId) : null
    if (!zip) {
      reply.code(409)
      return { error: 'evaluation export is not ready' }
    }
    reply
      .type('application/zip')
      .header('content-disposition', `attachment; filename="${task.archiveBase}.zip"`)
    return reply.send(zip)
  })

  app.delete<{ Params: { taskId: string } }>('/api/evaluation-exports/:taskId', async (req, reply) => {
    const task = readEvaluationExportTask(deps.store.logsDir, req.params.taskId)
    if (!task) {
      reply.code(404)
      return { error: 'evaluation export task not found' }
    }
    const active = activeEvaluationExports.get(task.taskId)
    if (task.status === 'running') {
      active?.abortController.abort()
      appendEvaluationExportLog(deps.store.logsDir, task.taskId, '[evaluation] task cancelled\n')
      active?.broker.push('export', '[evaluation] task cancelled\n')
    }
    active?.broker.markExit('export', task.status === 'running' ? 1 : 0)
    activeEvaluationExports.delete(req.params.taskId)
    deleteEvaluationExportTask(deps.store.logsDir, req.params.taskId)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-deleted', taskId: req.params.taskId })
    reply.code(204)
    return reply.send()
  })

  app.get<{ Params: { taskId: string } }>('/ws/evaluation-exports/:taskId', { websocket: true }, (socket, req) => {
    recoverStaleEvaluationExports()
    const task = readEvaluationExportTask(deps.store.logsDir, req.params.taskId)
    if (!task) {
      socket.send(JSON.stringify({ type: 'error', error: 'evaluation export task not found' }))
      socket.close()
      return
    }
    const log = readEvaluationExportLog(deps.store.logsDir, task.taskId)
    if (log.length > 0) {
      socket.send(JSON.stringify({ type: 'data', chunk: log }))
    }
    const active = activeEvaluationExports.get(task.taskId)
    if (!active) {
      socket.send(JSON.stringify({ type: 'exit', code: task.status === 'completed' ? 0 : 1 }))
      socket.close()
      return
    }
    const sub: PaneSubscriber = {
      send: (msg) => {
        try { socket.send(JSON.stringify(msg)) } catch { /* socket closed */ }
      },
      close: () => {
        try { socket.close() } catch { /* already closed */ }
      },
    }
    const unsub = active.broker.subscribe('export', sub, { replay: false })
    socket.on('close', () => unsub())
  })
}

function safeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
}

async function loadEvaluationRewrite(
  detail: Parameters<typeof generateEvaluationRewriteWithAgent>[0],
  runDir: string,
  audienceAdapter: Parameters<typeof generateEvaluationRewriteWithAgent>[1],
  projectRoot: string | undefined,
  generate: EvaluationRoutesDeps['generateEvaluationRewrite'],
  log?: Pick<FastifyInstance['log'], 'warn'>,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
  onSession?: (session: { agent: 'claude' | 'codex'; sessionId: string }) => void,
): Promise<EvaluationRewrite | undefined> {
  throwIfAborted(signal)
  const cached = readCachedEvaluationRewrite(runDir)
  if (cached) {
    onOutput?.('[evaluation] using cached localized wording\n')
    return cached
  }
  try {
    onOutput?.('[evaluation] generating localized wording\n')
    const generated = await (generate ?? generateEvaluationRewriteWithAgent)(detail, audienceAdapter, projectRoot, { onOutput, signal, onSession })
    throwIfAborted(signal)
    if (generated) {
      clearEvaluationRewriteError(runDir)
      writeCachedEvaluationRewrite(runDir, generated)
      onOutput?.('[evaluation] localized wording cached\n')
    } else {
      writeEvaluationRewriteError(runDir, `No evaluation rewrite was generated for adapter "${audienceAdapter ?? 'auto'}".`)
    }
    return generated ?? undefined
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log?.warn(`Evaluation rewrite failed for run ${detail.runId}: ${message}`)
    writeEvaluationRewriteError(runDir, message)
    return undefined
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('evaluation export cancelled')
}

function readCachedEvaluationRewrite(runDir: string): EvaluationRewrite | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runDir, 'evaluation-rewrite.json'), 'utf-8')) as EvaluationRewrite
    return parsed.formatVersion === EVALUATION_REWRITE_FORMAT_VERSION ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeCachedEvaluationRewrite(runDir: string, rewrite: EvaluationRewrite): void {
  try {
    fs.writeFileSync(path.join(runDir, 'evaluation-rewrite.json'), `${JSON.stringify({ ...rewrite, formatVersion: EVALUATION_REWRITE_FORMAT_VERSION }, null, 2)}\n`)
  } catch {
    return undefined
  }
}

function writeEvaluationRewriteError(runDir: string, message: string): void {
  try {
    fs.writeFileSync(path.join(runDir, 'evaluation-rewrite-error.txt'), `${message.trim()}\n`)
  } catch {
    return undefined
  }
}

function clearEvaluationRewriteError(runDir: string): void {
  try {
    fs.rmSync(path.join(runDir, 'evaluation-rewrite-error.txt'), { force: true })
  } catch {
    return undefined
  }
}

function parseEvaluationExportMode(value: string | undefined): EvaluationExportMode | null {
  return value === 'raw' || value === 'localized' ? value : null
}
