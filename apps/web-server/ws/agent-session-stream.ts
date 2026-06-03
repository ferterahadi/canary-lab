import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import {
  type AgentSessionRef,
  findClaudeLogBySessionId,
  locateMostRecentAgentSessionRef,
  parseAgentSessionRefFile,
  selectAgentSessionRef,
} from '../lib/agent-session-log'
import { tailAgentSession } from '../lib/agent-session-tailer'
import { resolveDraftStageSessionRef } from '../lib/draft-agent-session'
import { readDraft, paths as draftPaths } from '../lib/draft-store'
import { runDirFor, buildRunPaths } from '../lib/runtime/run-paths'
import { benchmarkDir } from '../lib/runtime/benchmark/paths'
import type { RunStore } from '../lib/run-store'

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
        onReady: (readyRef) => sendJson(socket, { type: 'session', agent: readyRef.agent, sessionId: readyRef.sessionId }),
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
        onReady: (readyRef) => sendJson(socket, { type: 'session', agent: readyRef.agent, sessionId: readyRef.sessionId }),
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
        onReady: (readyRef) => sendJson(socket, { type: 'session', agent: readyRef.agent, sessionId: readyRef.sessionId }),
        onEvent: (event) => sendJson(socket, { type: 'event', event }),
        onError: (err) => sendJson(socket, { type: 'error', error: err.message }),
        discoverRef: () => resolveBenchmarkRef(benchDir),
      })
      socket.on('close', () => handle.close())
    },
  )
}

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

function sendJson(socket: { send(data: string): void }, payload: unknown): void {
  try { socket.send(JSON.stringify(payload)) } catch { /* socket closed */ }
}
