import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import {
  type AgentSessionRef,
  findClaudeLogBySessionId,
  loadAgentSessionMeta,
  locateCodexSessionLog,
  locateMostRecentAgentSessionRef,
  parseAgentSessionRefFile,
  resolveManifestSessionRef,
  selectAgentSessionRef,
} from '../../agent-sessions/logic/agent-session-log'
import { readEvaluationExportTask } from '../../evaluation-artifacts/logic/evaluation-export-store'
import { tailAgentSession } from '../../agent-sessions/logic/agent-session-tailer'
import { resolveDraftStageSessionRef } from '../../evaluation-artifacts/logic/draft-agent-session'
import { readDraft, paths as draftPaths } from '../../evaluation-artifacts/logic/draft-store'
import { runDirFor, buildRunPaths } from '../../runs/logic/runtime/run-paths'
import { benchmarkDir } from '../../benchmark/logic/runtime/paths'
import { portifyDir } from '../../portify/logic/runtime/paths'
import { CoverageJobRunStore } from '../../coverage/logic/coverage/jobs/store'
import type { RunStore } from '../../runs/logic/run-store'

// WebSocket route that streams live structured agent-session events.
// Mirrors `draft-agent-stream.ts` (pty bytes) but emits normalized
// `AgentSessionEvent`s parsed from the agent CLI's own JSONL log.
//
// Protocol (one shape per route):
//   - { type: 'event', event }       per parsed line
//   - { type: 'done' }               agent log no longer appended for a while
//   - { type: 'error', error }       resolver/tailer failure
//
// Connections stay open until the client closes — the server doesn't decide
// "done" beyond surfacing tailer errors, because the JSONL may receive more
// events after a heal cycle restarts.

export interface AgentSessionStreamDeps {
  store: RunStore
  logsDir: string
  /** Project root — used to locate a coverage job's codex session by cwd (R17). */
  coverageProjectRoot?: string
}

export async function agentSessionStreamRoutes(
  app: FastifyInstance,
  deps: AgentSessionStreamDeps,
): Promise<void> {
  app.get<{ Params: { runId: string } }>(
    '/ws/runs/:runId/agent-session',
    { websocket: true },
    (socket, req) => {
      const detail = deps.store.get(req.params.runId)
      if (!detail) {
        sendJson(socket, { type: 'error', error: 'run-not-found' })
        try { socket.close() } catch { /* ignore */ }
        return
      }
      const runDir = runDirFor(deps.logsDir, req.params.runId)
      const ref = resolveRunRef(runDir)
      const handle = tailAgentSession({
        ref: ref ?? { agent: 'claude', sessionId: '', logPath: '' },
        onReady: (readyRef) => sendJson(socket, sessionMessage(readyRef)),
        onEvent: (event) => sendJson(socket, { type: 'event', event }),
        onError: (err) => sendJson(socket, { type: 'error', error: err.message }),
        discoverRef: () => resolveRunRef(runDir),
      })
      socket.on('close', () => handle.close())
    },
  )

  app.get<{ Params: { draftId: string }; Querystring: { stage?: string } }>(
    '/ws/draft/:draftId/agent-session',
    { websocket: true },
    (socket, req) => {
      const stage = parseStage(req.query.stage)
      if (!stage) {
        sendJson(socket, { type: 'error', error: 'unknown-stage' })
        try { socket.close() } catch { /* ignore */ }
        return
      }
      const draft = readDraft(deps.logsDir, req.params.draftId)
      if (!draft) {
        sendJson(socket, { type: 'error', error: 'draft-not-found' })
        try { socket.close() } catch { /* ignore */ }
        return
      }
      const ref = stage === 'planning' ? draft.planAgentSessionRef : draft.specAgentSessionRef
      const agent = ref?.agent ?? draft.wizardAgent ?? 'claude'
      const p = draftPaths(deps.logsDir, req.params.draftId)
      const handle = tailAgentSession({
        ref: ref ?? { agent, sessionId: '', logPath: '' },
        onReady: (readyRef) => sendJson(socket, sessionMessage(readyRef)),
        onEvent: (event) => sendJson(socket, { type: 'event', event }),
        onError: (err) => sendJson(socket, { type: 'error', error: err.message }),
        discoverRef: () => {
          // Re-read the draft each time — refs may be filled in after the
          // initial connection (race between WS attach and spawn writing the
          // ref to disk). For codex, use the stage spawn timestamp so a new
          // draft never displays an older draft session.
          const fresh = readDraft(deps.logsDir, req.params.draftId)
          const freshRef = stage === 'planning' ? fresh?.planAgentSessionRef : fresh?.specAgentSessionRef
          const spawnedAt = stage === 'planning' ? fresh?.planAgentSpawnedAt : fresh?.specAgentSpawnedAt
          return resolveDraftStageSessionRef({
            ref: freshRef,
            agent: freshRef?.agent ?? fresh?.wizardAgent ?? agent,
            draftDir: p.draftDir,
            spawnedAt,
          })
        },
      })
      socket.on('close', () => handle.close())
    },
  )

  // Benchmark sabotage-agent session — resolves the ref the runner wrote into
  // the benchmark dir and tails the native claude log, same as runs/drafts.
  app.get<{ Params: { benchmarkId: string } }>(
    '/ws/benchmarks/:benchmarkId/agent-session',
    { websocket: true },
    (socket, req) => {
      const benchDir = benchmarkDir(deps.logsDir, req.params.benchmarkId)
      const ref = resolveBenchmarkRef(benchDir)
      const handle = tailAgentSession({
        ref: ref ?? { agent: 'claude', sessionId: '', logPath: '' },
        onReady: (readyRef) => sendJson(socket, sessionMessage(readyRef)),
        onEvent: (event) => sendJson(socket, { type: 'event', event }),
        onError: (err) => sendJson(socket, { type: 'error', error: err.message }),
        discoverRef: () => resolveBenchmarkRef(benchDir),
      })
      socket.on('close', () => handle.close())
    },
  )

  // Coverage/summary job agent session (R17). The job persists its pinned
  // sessionRef on the manifest; resolve it (claude by id, codex by cwd + start)
  // and tail the agent CLI's JSONL, same as runs/drafts.
  app.get<{ Params: { jobId: string } }>(
    '/ws/coverage/jobs/:jobId/agent-session',
    { websocket: true },
    (socket, req) => {
      const jobStore = new CoverageJobRunStore(deps.logsDir)
      const resolve = () => resolveCoverageJobRef(jobStore, req.params.jobId, deps.coverageProjectRoot)
      const handle = tailAgentSession({
        ref: resolve() ?? { agent: 'claude', sessionId: '', logPath: '' },
        onReady: (readyRef) => sendJson(socket, sessionMessage(readyRef)),
        onEvent: (event) => sendJson(socket, { type: 'event', event }),
        onError: (err) => sendJson(socket, { type: 'error', error: err.message }),
        discoverRef: resolve,
      })
      socket.on('close', () => handle.close())
    },
  )

  // Evaluation-export localized-rewrite agent session. The export task persists
  // its pinned sessionRef on the task record; resolve it (claude by id, codex by
  // project root + start) and tail the agent CLI's JSONL, same as coverage.
  app.get<{ Params: { taskId: string } }>(
    '/ws/evaluation-exports/:taskId/agent-session',
    { websocket: true },
    (socket, req) => {
      const resolve = () => resolveEvaluationExportRef(deps.logsDir, req.params.taskId, deps.coverageProjectRoot)
      const handle = tailAgentSession({
        ref: resolve() ?? { agent: 'claude', sessionId: '', logPath: '' },
        onReady: (readyRef) => sendJson(socket, sessionMessage(readyRef)),
        onEvent: (event) => sendJson(socket, { type: 'event', event }),
        onError: (err) => sendJson(socket, { type: 'error', error: err.message }),
        discoverRef: resolve,
      })
      socket.on('close', () => handle.close())
    },
  )

  // Port-ification agent session — same ref-file convention as the benchmark,
  // under the portify workflow dir.
  app.get<{ Params: { workflowId: string } }>(
    '/ws/portify/:workflowId/agent-session',
    { websocket: true },
    (socket, req) => {
      const dir = portifyDir(deps.logsDir, req.params.workflowId)
      const ref = resolveBenchmarkRef(dir)
      const handle = tailAgentSession({
        ref: ref ?? { agent: 'claude', sessionId: '', logPath: '' },
        onReady: (readyRef) => sendJson(socket, sessionMessage(readyRef)),
        onEvent: (event) => sendJson(socket, { type: 'event', event }),
        onError: (err) => sendJson(socket, { type: 'error', error: err.message }),
        discoverRef: () => resolveBenchmarkRef(dir),
      })
      socket.on('close', () => handle.close())
    },
  )
}

// Resolve the agent-session ref written into a workflow dir (benchmark or
// portify) — both use the same `<dir>/agent-session.json` convention.
function resolveBenchmarkRef(benchDir: string): AgentSessionRef | null {
  let raw: string | null = null
  try { raw = fs.readFileSync(path.join(benchDir, 'agent-session.json'), 'utf-8') } catch { return null }
  const parsed = raw ? parseAgentSessionRefFile(raw) : null
  const ref = parsed ? selectAgentSessionRef(parsed) : null
  if (!ref) return null
  // The cwd-derived logPath can be wrong (Claude's project-dir slug folds more
  // than `/`). Once the log exists, locate it by session id instead.
  if (ref.logPath && fs.existsSync(ref.logPath)) return ref
  const found = ref.agent === 'claude' ? findClaudeLogBySessionId(ref.sessionId) : null
  return found ? { ...ref, logPath: found } : ref
}

// Resolve the agent session a coverage/summary job pinned on its manifest.
// claude: by globally-unique session id; codex: by cwd (project root) + start.
function resolveCoverageJobRef(
  store: CoverageJobRunStore,
  jobId: string,
  projectRoot: string | undefined,
): AgentSessionRef | null {
  const manifest = store.get(jobId)
  const ref = manifest?.sessionRef
  if (!ref) return null
  if (ref.agent === 'claude') {
    if (!ref.sessionId) return null
    const logPath = findClaudeLogBySessionId(ref.sessionId)
    return logPath ? { agent: 'claude', sessionId: ref.sessionId, logPath } : null
  }
  if (!projectRoot || !manifest) return null
  return locateCodexSessionLog(projectRoot, manifest.startedAt)
}

// Resolve the localized-rewrite agent session an evaluation-export task pinned
// on its record. claude: by session id; codex: by project root + the task's
// creation time (≈ spawn time).
function resolveEvaluationExportRef(
  logsDir: string,
  taskId: string,
  projectRoot: string | undefined,
): AgentSessionRef | null {
  const task = readEvaluationExportTask(logsDir, taskId)
  if (!task) return null
  return resolveManifestSessionRef(task.sessionRef, { projectRoot, startedAt: task.createdAt })
}

function resolveRunRef(runDir: string): AgentSessionRef | null {
  const found = locateMostRecentAgentSessionRef(runDir)
  if (found) return found
  const refPath = buildRunPaths(runDir).agentSessionRefPath
  let raw: string | null = null
  try { raw = fs.readFileSync(refPath, 'utf-8') } catch { return null }
  const parsed = raw ? parseAgentSessionRefFile(raw) : null
  return parsed ? selectAgentSessionRef(parsed) : null
}

function parseStage(value: string | undefined): 'planning' | 'generating' | null {
  if (value === undefined) return 'planning'
  if (value === 'planning' || value === 'generating') return value
  return null
}

// Build the `session` handshake message, reading model/effort from the log
// once it's been located. The log exists by the time `onReady` fires, so a
// codex `turn_context` (written right after `session_meta`) is already present.
function sessionMessage(ref: AgentSessionRef): {
  type: 'session'
  agent: AgentSessionRef['agent']
  sessionId: string
  model?: string
  effort?: string
} {
  const meta = loadAgentSessionMeta(ref)
  return { type: 'session', agent: ref.agent, sessionId: ref.sessionId, model: meta.model, effort: meta.effort }
}

function sendJson(socket: { send(data: string): void }, payload: unknown): void {
  try { socket.send(JSON.stringify(payload)) } catch { /* socket closed */ }
}
