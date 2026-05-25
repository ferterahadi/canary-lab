import type { FastifyInstance, FastifyReply } from 'fastify'
import fs from 'fs'
import path from 'path'
import type { PlaywrightArtifact, RunDetail } from '../lib/run-store'
import type { RunStore, OrchestratorLike, RestartHealResult, RestartRunResult } from '../lib/run-store'
import { loadFeatures } from '../lib/feature-loader'
import { buildRunPaths, runDirFor } from '../lib/runtime/run-paths'
import { createEvaluationExport, generateEvaluationRewriteWithAgent, type EvaluationRewrite } from '../lib/test-review-export'
import { loadProjectConfig } from '../lib/runtime/launcher/project-config'
import { PaneBroker, type PaneSubscriber } from '../lib/pane-broker'
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
} from '../lib/evaluation-export-store'
import {
  loadAgentSessionLog,
  locateMostRecentAgentSessionRef,
  parseAgentSessionRefFile,
  selectAgentSessionRef,
} from '../lib/agent-session-log'
import { isTerminalRunStatus } from '../../../shared/run-state'
import type { ExternalHealBroker } from '../lib/external-heal-broker'

const EVALUATION_REWRITE_FORMAT_VERSION = 6

interface ActiveEvaluationExportTask {
  broker: PaneBroker
  abortController: AbortController
}

export interface ExternalHealAgentRequest {
  kind: 'external'
  sessionId: string
  clientKind: 'claude-cli' | 'claude-desktop' | 'codex-cli' | 'codex-desktop' | 'other'
  clientVersion?: string
  conversationName?: string
}

export interface RunsRouteDeps {
  featuresDir: string
  projectRoot?: string
  /** Single source of truth for run state. Routes read + mutate exclusively
   *  through this — no direct manifest/index file access. */
  store: RunStore
  // Factory: given a feature name + optional healAgent override, build + start
  // an orchestrator. Returns the orchestrator synchronously after `start()` is
  // in flight (the factory awaits the initial spawn but not test completion).
  // When `healAgent.kind === 'external'`, the orchestrator must be configured
  // with externalHeal=true and the external-heal broker claim should be
  // bootstrapped before the orchestrator's heal-loop entry condition triggers.
  startRun(
    feature: string,
    env?: string,
    healAgent?: ExternalHealAgentRequest,
  ): Promise<OrchestratorLike>
  broker?: Pick<ExternalHealBroker, 'claim'>
  restartHeal?(runId: string, text: string): Promise<RestartHealResult>
  restartRun?(runId: string): Promise<RestartRunResult>
  generateEvaluationRewrite?(
    detail: Parameters<typeof generateEvaluationRewriteWithAgent>[0],
    audienceAdapter: Parameters<typeof generateEvaluationRewriteWithAgent>[1],
    projectRoot?: string,
    options?: Parameters<typeof generateEvaluationRewriteWithAgent>[3],
  ): Promise<EvaluationRewrite | null>
}

export async function runsRoutes(app: FastifyInstance, deps: RunsRouteDeps): Promise<void> {
  const activeEvaluationExports = new Map<string, ActiveEvaluationExportTask>()

  app.get<{ Querystring: { feature?: string } }>('/api/runs', async (req) => {
    return deps.store.list({ feature: req.query.feature })
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    return detail
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/verification-report', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    if ((detail.manifest.executionType ?? 'run') !== 'verify') {
      reply.code(409)
      return { error: 'run is not a verification execution' }
    }
    return {
      runId: detail.runId,
      executionType: 'verify',
      status: detail.manifest.status,
      verification: detail.manifest.verification ?? null,
    }
  })

  // Structured heal-agent session view. Reads the per-run pointer file
  // (`agent-session.json`) the orchestrator writes after a heal cycle ends,
  // then parses + normalizes the agent CLI's own JSONL log into a uniform
  // event stream for both claude and codex. 404 with a `reason` field in
  // every failure mode — the UI falls back to the raw transcript replay.
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/agent-session', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { reason: 'run-not-found' }
    }
    const runDir = runDirFor(deps.store.logsDir, req.params.runId)
    // Prefer the most-recently-modified agent JSONL on disk over the
    // orchestrator-written ref file. The ref file is only updated when the
    // heal loop's cleanup runs cleanly — a SIGKILL'd server or a one-off
    // locator miss leaves it pointing at a stale agent (e.g. claude) even
    // when codex has since produced newer cycles for the same runDir. Fall
    // back to the ref file when no on-disk logs are locatable.
    const refPath = buildRunPaths(runDir).agentSessionRefPath
    let raw: string | null = null
    try { raw = fs.readFileSync(refPath, 'utf-8') } catch { /* missing or unreadable */ }
    const parsed = raw ? parseAgentSessionRefFile(raw) : null
    const ref = locateMostRecentAgentSessionRef(runDir)
      ?? (parsed ? selectAgentSessionRef(parsed) : null)
    if (!ref) {
      reply.code(404)
      return { reason: 'no-session-ref' }
    }
    if (!fs.existsSync(ref.logPath)) {
      reply.code(404)
      return { reason: 'session-log-missing' }
    }
    const events = loadAgentSessionLog(ref)
    return { agent: ref.agent, sessionId: ref.sessionId, events }
  })

  const buildEvaluationZip = async (
    detail: RunDetail,
    mode: EvaluationExportMode,
    log?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<{ archiveBase: string; zip: Buffer }> => {
    throwIfAborted(signal)
    log?.(`[evaluation] preparing ${mode === 'raw' ? 'raw output' : 'localized output'} export\n`)
    const runPaths = buildRunPaths(runDirFor(deps.store.logsDir, detail.runId))
    const videos = assertionVideos(
      detail.playwrightArtifacts,
      runPaths.playwrightArtifactsDir,
      runPaths.playwrightArtifactsKeepDir,
      detail.runId,
    )
    const archiveBase = `canary-lab-evaluation-${safeFilename(detail.manifest.feature)}-${safeFilename(detail.runId)}`
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
      ? await loadEvaluationRewrite(detail, runDir, audienceAdapter, deps.projectRoot, deps.generateEvaluationRewrite, app.log, log, signal)
      : undefined
    throwIfAborted(signal)
    const exported = await createEvaluationExport(detail, {
      audienceAdapter,
      rewrite,
      videoLinksByTestName: videoLinksByTestName(videos),
    })
    const zip = createZip([
      { filename: 'evaluation.html', data: Buffer.from(exported.html, 'utf8') },
      ...exported.assets,
      ...videos.map((video) => ({ filename: video.filename, data: fs.readFileSync(video.path) })),
    ])
    log?.('[evaluation] export archive ready\n')
    return { archiveBase, zip }
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
      const message = 'evaluation export interrupted; start a new export'
      appendEvaluationExportLog(deps.store.logsDir, task.taskId, `[evaluation] task failed: ${message}\n`)
      patchEvaluationExportTask(deps.store.logsDir, task.taskId, {
        status: 'failed',
        downloadReady: false,
        error: message,
      })
    }
  }

  const startEvaluationExportTask = (detail: RunDetail, mode: EvaluationExportMode) => {
    const now = new Date().toISOString()
    const task: EvaluationExportTaskRecord = {
      taskId: `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      runId: detail.runId,
      feature: detail.manifest.feature,
      mode,
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
    activeEvaluationExports.set(task.taskId, active)
    const push = (chunk: string): void => {
      appendEvaluationExportLog(deps.store.logsDir, task.taskId, chunk)
      active.broker.push('export', chunk)
    }
    push(`[evaluation] task ${task.taskId} started\n`)
    void (async () => {
      try {
        const built = await buildEvaluationZip(detail, mode, push, active.abortController.signal)
        if (!readEvaluationExportTask(deps.store.logsDir, task.taskId)) return
        writeEvaluationExportZip(deps.store.logsDir, task.taskId, built.zip)
        patchEvaluationExportTask(deps.store.logsDir, task.taskId, {
          archiveBase: built.archiveBase,
          status: 'completed',
          downloadReady: true,
        })
        push('[evaluation] task completed\n')
        active.broker.markExit('export', 0)
      } catch (err) {
        if (!readEvaluationExportTask(deps.store.logsDir, task.taskId)) return
        const error = err instanceof Error ? err.message : String(err)
        patchEvaluationExportTask(deps.store.logsDir, task.taskId, {
          status: 'failed',
          error,
          downloadReady: false,
        })
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

  app.get<{ Params: { runId: string; '*': string } }>('/api/runs/:runId/artifacts/*', async (req, reply) => {
    const runDir = runDirFor(deps.store.logsDir, req.params.runId)
    const runPaths = buildRunPaths(runDir)
    // Try the live `playwright-artifacts/` first, then fall back to the
    // durable `playwright-artifacts-keep/` snapshot. Heal-cycle reruns wipe
    // the live dir at the start of every Playwright invocation, so the keep
    // dir is what carries the videos/traces for tests not in the latest
    // rerun selection.
    const bases = [runPaths.playwrightArtifactsDir, runPaths.playwrightArtifactsKeepDir]
    let validRel: string | null = null
    for (const base of bases) {
      const requested = path.resolve(base, req.params['*'])
      const rel = path.relative(base, requested)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      validRel = rel
      try {
        const stat = fs.statSync(requested)
        if (stat.isFile()) {
          reply.type(contentTypeFor(requested))
          return reply.send(fs.createReadStream(requested))
        }
      } catch { /* try next base */ }
    }
    if (validRel === null) {
      reply.code(400)
      return { error: 'invalid artifact path' }
    }
    reply.code(404)
    return { error: 'artifact not found' }
  })

  app.post<{
    Body: {
      feature?: string
      env?: string
      healAgent?: ExternalHealAgentRequest | { kind?: string }
      forceNew?: boolean
    }
  }>('/api/runs', async (req, reply) => {
    const feature = req.body?.feature
    if (typeof feature !== 'string' || feature.length === 0) {
      reply.code(400)
      return { error: 'feature required' }
    }
    const features = loadFeatures(deps.featuresDir)
    const featureCfg = features.find((f) => f.name === feature)
    if (!featureCfg) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    // env is optional only when the feature didn't declare any. Otherwise it
    // must be one of feature.envs (default: first entry).
    const declared = featureCfg.envs ?? []
    const env = declared.length > 0 ? (req.body?.env ?? declared[0]) : undefined
    if (declared.length > 0 && (typeof env !== 'string' || !declared.includes(env))) {
      reply.code(400)
      return { error: `env must be one of: ${declared.join(', ')}` }
    }
    const healAgent = parseExternalHealAgent(req.body?.healAgent)
    if (healAgent && 'error' in healAgent) {
      reply.code(400)
      return { error: healAgent.error }
    }
    if (healAgent) {
      const active = findActiveRunForFeature(deps.store, feature, env)
      if (active) {
        const claim = deps.broker?.claim(active.manifest.runId, {
          sessionId: healAgent.sessionId,
          clientKind: healAgent.clientKind,
          ...(healAgent.clientVersion ? { clientVersion: healAgent.clientVersion } : {}),
          ...(healAgent.conversationName ? { conversationName: healAgent.conversationName } : {}),
        }) ?? null
        reply.code(200)
        return {
          runId: active.manifest.runId,
          reused: true,
          status: active.manifest.status,
          claimed: claim ? claim.accepted : false,
          claim,
          ...(req.body?.forceNew
            ? {
                ignoredForceNew: true,
                warning: 'An active run already exists for this feature. Continue it with signal_run and wait_for_heal_task instead of starting a fresh run.',
              }
            : {}),
        }
      }
    }
    try {
      const orch = await deps.startRun(feature, env, healAgent ?? undefined)
      deps.store.registry.set(orch.runId, orch)
      reply.code(201)
      return { runId: orch.runId }
    } catch (err) {
      const code = typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500
      reply.code(code)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Mid-Run Heal: manual interruption. Looks up the orchestrator in the
  // registry, asks it to SIGTERM Playwright + jump into the heal cycle.
  // 404 when unknown, 409 with a reason when pausing is meaningless,
  // 202 + status payload on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/pause-heal', async (req, reply) => {
    const orch = deps.store.registry.get(req.params.runId)
    if (!orch) {
      reply.code(404)
      return { error: 'run not active' }
    }
    const result = await orch.pauseAndHeal()
    if (!result.ok) {
      reply.code(409)
      return { reason: result.reason }
    }
    reply.code(202)
    return { status: 'healing', failureCount: result.failureCount }
  })

  // Cancel an in-flight heal cycle. SIGTERMs the agent pty, breaks the heal
  // loop, appends a journal entry. 404 when unknown, 409 with a reason when
  // there's nothing to cancel, 202 on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/cancel-heal', async (req, reply) => {
    const orch = deps.store.registry.get(req.params.runId)
    if (!orch) {
      reply.code(404)
      return { error: 'run not active' }
    }
    const result = await orch.cancelHeal()
    if (!result.ok) {
      reply.code(409)
      return { reason: result.reason }
    }
    reply.code(202)
    return { status: 'cancelled' }
  })

  // Live interject — pipe a line of text to the running heal agent's stdin
  // so the user can guide the agent without restarting the cycle. 404 when
  // unknown, 409 when there's no agent running for this run.
  app.post<{ Params: { runId: string }; Body: { data: string } }>(
    '/api/runs/:runId/agent-input',
    async (req, reply) => {
      if (typeof req.body?.data !== 'string') {
        reply.code(400)
        return { error: 'data must be a string' }
      }
      const orch = deps.store.registry.get(req.params.runId)
      if (!orch) {
        const restarted = await deps.restartHeal?.(req.params.runId, req.body.data)
        if (restarted?.ok) {
          reply.code(202)
          return { status: 'restarted' }
        }
        reply.code(restarted?.reason === 'spawn-failed' ? 500 : 409)
        return { reason: restarted?.reason ?? 'no-agent-running' }
      }
      if (!orch.interjectHealAgent) {
        reply.code(409)
        return { reason: 'no-agent-running' }
      }
      const result = await orch.interjectHealAgent(req.body.data)
      if (!result.ok) {
        if (result.reason === 'no-agent-running') {
          const restarted = await deps.restartHeal?.(req.params.runId, req.body.data)
          if (restarted?.ok) {
            reply.code(202)
            return { status: 'restarted' }
          }
        }
        reply.code(409)
        return { reason: result.reason }
      }
      reply.code(202)
      return { status: 'sent' }
    },
  )

  app.post<{ Params: { runId: string } }>('/api/runs/:runId/restart', async (req, reply) => {
    const restarted = await deps.restartRun?.(req.params.runId)
    if (restarted?.ok) {
      reply.code(202)
      return { status: 'restarted', mode: restarted.mode }
    }
    const reason = restarted?.reason ?? 'not-restartable'
    reply.code(reason === 'run-not-found' ? 404 : reason === 'spawn-failed' ? 500 : 409)
    return { reason }
  })

  // POST /api/runs/:runId/abort — explicit abort of an active run. Stops
  // the orchestrator (kills Playwright + heal agent + service ptys) and
  // marks the manifest 'aborted'. The run is preserved in history so the
  // user can audit the logs after. 404 when not active, 204 on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/abort', async (req, reply) => {
    const result = await deps.store.abort(req.params.runId)
    if (!result.ok) {
      reply.code(404)
      return { error: 'run not active' }
    }
    reply.code(204)
    return ''
  })

  // DELETE /api/runs/:runId — hard-remove a terminal run from history.
  // The action-matrix policy (active runs must be aborted first) lives in
  // `RunStore.delete`; the route just maps the structured failure into HTTP
  // status codes.
  app.delete<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const result = deps.store.delete(req.params.runId)
    if (!result.ok) {
      if (result.reason === 'not-found') {
        reply.code(404)
        return { error: 'run not found' }
      }
      reply.code(409)
      return {
        error: result.reason === 'active'
          ? 'run is still active; abort it first'
          : 'run is still active; reap or abort first',
      }
    }
    reply.code(204)
    return ''
  })
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.zip') return 'application/zip'
  return 'application/octet-stream'
}

function safeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
}

function assertionVideos(
  groups: Array<{ testName: string; artifacts: PlaywrightArtifact[] }> | undefined,
  artifactsDir: string,
  artifactsKeepDir: string,
  runId: string,
): Array<{ filename: string; path: string; testName: string }> {
  // Mirror indexPlaywrightArtifacts.resolveFile: artifact.path is rooted at
  // the live artifacts dir, but after heal-cycle reruns the live dir only
  // holds the last invocation's outputs. Fall back to the keep dir so videos
  // from earlier invocations still make it into the export.
  const fileAt = (rel: string): string | null => {
    const live = path.resolve(artifactsDir, rel)
    if (fs.existsSync(live) && fs.statSync(live).isFile()) return live
    const kept = path.resolve(artifactsKeepDir, rel)
    if (fs.existsSync(kept) && fs.statSync(kept).isFile()) return kept
    return null
  }
  const videos = (groups ?? [])
    .flatMap((group) => group.artifacts.map((artifact) => ({ artifact, testName: group.testName })))
    .map(({ artifact, testName }) => {
      const rel = path.relative(artifactsDir, path.resolve(artifactsDir, artifact.path))
      const valid = !rel.startsWith('..') && !path.isAbsolute(rel)
      const filePath = valid ? fileAt(rel) : null
      return { artifact, filePath, testName, valid }
    })
    .filter((entry): entry is { artifact: PlaywrightArtifact; filePath: string; testName: string; valid: boolean } =>
      entry.valid && entry.artifact.kind === 'video' && entry.filePath !== null)
  const used = new Set<string>()
  return videos.map(({ artifact, filePath, testName }, idx) => {
    const ext = path.extname(filePath) || extensionForContentType(artifact.contentType) || '.webm'
    const suffix = videos.length === 1 ? '' : `-${idx + 1}`
    let filename = `${safeFilename(runId)}${suffix}${ext}`
    let dedupe = 2
    while (used.has(filename)) {
      filename = `${safeFilename(runId)}${suffix}-${dedupe}${ext}`
      dedupe += 1
    }
    used.add(filename)
    return { filename, path: filePath, testName }
  })
}

function videoLinksByTestName(videos: Array<{ filename: string; testName: string }>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const video of videos) out[video.testName] = [...(out[video.testName] ?? []), video.filename]
  return out
}

function extensionForContentType(contentType: string | undefined): string | undefined {
  if (contentType === 'video/mp4') return '.mp4'
  if (contentType === 'video/webm') return '.webm'
  return undefined
}

async function loadEvaluationRewrite(
  detail: Parameters<typeof generateEvaluationRewriteWithAgent>[0],
  runDir: string,
  audienceAdapter: Parameters<typeof generateEvaluationRewriteWithAgent>[1],
  projectRoot: string | undefined,
  generate: RunsRouteDeps['generateEvaluationRewrite'],
  log?: Pick<FastifyInstance['log'], 'warn'>,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<EvaluationRewrite | undefined> {
  throwIfAborted(signal)
  const cached = readCachedEvaluationRewrite(runDir)
  if (cached) {
    onOutput?.('[evaluation] using cached localized wording\n')
    return cached
  }
  try {
    onOutput?.('[evaluation] generating localized wording\n')
    const generated = await (generate ?? generateEvaluationRewriteWithAgent)(detail, audienceAdapter, projectRoot, { onOutput, signal })
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

const EXTERNAL_CLIENT_KINDS: ExternalHealAgentRequest['clientKind'][] = [
  'claude-cli',
  'claude-desktop',
  'codex-cli',
  'codex-desktop',
  'other',
]

function parseExternalHealAgent(
  value: unknown,
): ExternalHealAgentRequest | { error: string } | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') return { error: 'healAgent must be an object' }
  const v = value as Record<string, unknown>
  if (v.kind === undefined) return null
  // v1 only wires up the external kind via this body field; the existing
  // project-config healAgent setting remains the source of truth for
  // 'auto' / 'claude' / 'codex' / 'manual'. The body override is *only* the
  // hook for external MCP clients to register themselves at run start.
  if (v.kind !== 'external') {
    return { error: 'healAgent.kind must be "external" when overriding from the request body' }
  }
  if (typeof v.sessionId !== 'string' || !v.sessionId) {
    return { error: 'healAgent.sessionId is required when kind="external"' }
  }
  if (typeof v.clientKind !== 'string' || !(EXTERNAL_CLIENT_KINDS as string[]).includes(v.clientKind)) {
    return { error: `healAgent.clientKind must be one of: ${EXTERNAL_CLIENT_KINDS.join(', ')}` }
  }
  return {
    kind: 'external',
    sessionId: v.sessionId,
    clientKind: v.clientKind as ExternalHealAgentRequest['clientKind'],
    ...(typeof v.clientVersion === 'string' ? { clientVersion: v.clientVersion } : {}),
    ...(typeof v.conversationName === 'string' ? { conversationName: v.conversationName } : {}),
  }
}

function findActiveRunForFeature(
  store: RunStore,
  feature: string,
  env: string | undefined,
): RunDetail | null {
  const candidates: Array<{ detail: RunDetail; startedAt: string }> = []
  for (const entry of store.list({ feature })) {
    if (entry.status !== 'healing') continue
    const detail = store.get(entry.runId)
    if (!detail) continue
    if (env && detail.manifest.env !== env) continue
    candidates.push({ detail, startedAt: entry.startedAt })
  }
  candidates.sort((a, b) => {
    const priorityDiff = activeRunPriority(a.detail) - activeRunPriority(b.detail)
    if (priorityDiff !== 0) return priorityDiff
    return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
  })
  return candidates[0]?.detail ?? null
}

function activeRunPriority(detail: RunDetail): number {
  if (detail.manifest.lifecycle?.phase === 'waiting-for-signal') return 0
  if (detail.manifest.status === 'healing') return 1
  return 2
}

interface ZipEntry {
  filename: string
  data: Buffer
}

function createZip(entries: ZipEntry[]): Buffer {
  const fileRecords: Buffer[] = []
  const centralRecords: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.filename, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const fileRecord = Buffer.concat([local, name, entry.data])
    fileRecords.push(fileRecord)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralRecords.push(Buffer.concat([central, name]))
    offset += fileRecord.length
  }
  const centralOffset = offset
  const centralDirectory = Buffer.concat(centralRecords)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([...fileRecords, centralDirectory, end])
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
