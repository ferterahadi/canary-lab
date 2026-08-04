// Locate, parse, and normalize the structured session log that the heal
// agent's CLI persists by itself.
//
// Both `claude` and `codex` write a JSONL session record outside our run
// directory:
//
//   ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<iso-ts>-<uuid>.jsonl
//
// The shapes differ but carry the same information — user/assistant
// messages, tool calls, tool results, timestamps. The historical replay
// path renders the normalized stream instead of the raw PTY transcript,
// which is dominated by TUI redraw noise that doesn't replay cleanly.
//
// Locator strategy:
//   - claude: we pin the session UUID at spawn (`--session-id <uuid>`) so
//     the log path is fully determined by `runDir` + uuid.
//   - codex: no `--session-id` flag exists, so we discover the log
//     post-hoc by matching `session_meta.cwd === runDir` and
//     `session_meta.timestamp >= cycleStartedAt`. The runDir is unique
//     per run, so there's no cross-run ambiguity.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyAgentSessionMetaLine, parseAgentSessionLine } from './agent-session-parse'
import { claudeSessionLogPath, findClaudeLogBySessionId, locateCodexSessionLog, locateLatestClaudeSessionLog, locateLatestCodexSessionLog, readCodexDiscoveryHint, realpathOrSelf, safeMtimeMs } from './agent-session-paths'

export { parseAgentSessionLine } from './agent-session-parse'
export { claudeConfigDir, claudeProjectDirCandidates, claudeSessionLogPath, codexConfigDir, encodeClaudeProjectDir, findClaudeLogBySessionId, locateClaudeSessionLog, locateCodexSessionLog, locateLatestClaudeSessionLog, locateLatestCodexSessionLog, locateLatestSessionLogForAgent } from './agent-session-paths'
export { buildFullSessionTranscript, renderAgentSessionContext, writeFullSessionTranscript } from './agent-session-render'
export { buildAgentSessionResponse, loadSubagentThread, loadSubagentThreads, subagentDirFor } from './agent-session-subagents'
export type { SubagentThread } from './agent-session-subagents'

export type AgentKind = 'claude' | 'codex'

export interface AgentSessionRef {
  agent: AgentKind
  sessionId: string
  // Absolute path to the agent CLI's JSONL session log on disk.
  logPath: string
}

export interface AgentSessionRefFile {
  activeAgent?: AgentKind
  sessions: Partial<Record<AgentKind, AgentSessionRef>>
}

export type AgentEvent =
  | { kind: 'user-message'; timestamp: string; text: string }
  // `apiError` marks a turn the CLI synthesized after the model's HTTP stream
  // dropped mid-response ("Connection closed mid-response"). It is NOT the
  // agent's own prose — the surrounding text is whatever partial output was
  // recovered — so the UI renders it as a termination, not a conclusion.
  | { kind: 'assistant-message'; timestamp: string; text: string; apiError?: boolean }
  | { kind: 'assistant-thinking'; timestamp: string; text: string }
  | { kind: 'tool-call'; timestamp: string; toolId: string; name: string; input: unknown }
  | { kind: 'tool-result'; timestamp: string; toolId: string; output: string; isError?: boolean }

// Session-level metadata that doesn't map to a timeline event: which model the
// agent ran and (codex only) its reasoning effort. Both agents record this in
// their JSONL but in different lines — codex in a `turn_context` record,
// claude in each assistant message's `message.model`. Claude has no notion of
// reasoning effort, so `effort` stays undefined for it.
export interface AgentSessionMeta {
  model?: string
  effort?: string
}

export function parseAgentSessionRefFile(raw: string): AgentSessionRefFile | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as {
    activeAgent?: unknown
    sessions?: unknown
    agent?: unknown
    sessionId?: unknown
    logPath?: unknown
  }

  const legacy = normalizeAgentSessionRef(obj)
  if (legacy) {
    return { activeAgent: legacy.agent, sessions: { [legacy.agent]: legacy } }
  }

  const out: AgentSessionRefFile = { sessions: {} }
  if (obj.activeAgent === 'claude' || obj.activeAgent === 'codex') {
    out.activeAgent = obj.activeAgent
  }
  if (obj.sessions && typeof obj.sessions === 'object') {
    const sessions = obj.sessions as Partial<Record<AgentKind, unknown>>
    const claude = normalizeAgentSessionRef(sessions.claude)
    const codex = normalizeAgentSessionRef(sessions.codex)
    if (claude?.agent === 'claude') out.sessions.claude = claude
    if (codex?.agent === 'codex') out.sessions.codex = codex
  }
  return out.sessions.claude || out.sessions.codex ? out : null
}

export function selectAgentSessionRef(file: AgentSessionRefFile, preferredAgent?: AgentKind): AgentSessionRef | null {
  if (preferredAgent && file.sessions[preferredAgent]) return file.sessions[preferredAgent]!
  if (file.activeAgent && file.sessions[file.activeAgent]) return file.sessions[file.activeAgent]!
  return file.sessions.codex ?? file.sessions.claude ?? null
}

function normalizeAgentSessionRef(value: unknown): AgentSessionRef | null {
  if (!value || typeof value !== 'object') return null
  const ref = value as { agent?: unknown; sessionId?: unknown; logPath?: unknown }
  if (ref.agent !== 'claude' && ref.agent !== 'codex') return null
  if (typeof ref.sessionId !== 'string' || typeof ref.logPath !== 'string') return null
  return { agent: ref.agent, sessionId: ref.sessionId, logPath: ref.logPath }
}

// Resolve a session ref a background job pinned on its manifest into a locatable
// log ref — claude by its globally-unique session id, codex by cwd (project
// root) + the job's start time. Shared by the coverage and evaluation-export
// agent-session surfaces.
export function resolveManifestSessionRef(
  sessionRef: { agent: AgentKind; sessionId: string } | undefined,
  opts: { projectRoot?: string; startedAt?: string },
): AgentSessionRef | null {
  if (!sessionRef) return null
  if (sessionRef.agent === 'claude') {
    if (!sessionRef.sessionId) return null
    const logPath = findClaudeLogBySessionId(sessionRef.sessionId)
    return logPath ? { agent: 'claude', sessionId: sessionRef.sessionId, logPath } : null
  }
  if (!opts.projectRoot || !opts.startedAt) return null
  return locateCodexSessionLog(opts.projectRoot, opts.startedAt)
}

export function writeWorkflowAgentRef(
  dir: string,
  opts: { agent: AgentKind; cwd: string; spawnedAt: string; sessionId?: string },
  homeDir: string = os.homedir(),
): void {
  try {
    const file =
      opts.agent === 'claude' && opts.sessionId
        ? {
            activeAgent: 'claude' as const,
            sessions: {
              claude: {
                agent: 'claude' as const,
                sessionId: opts.sessionId,
                logPath: claudeSessionLogPath(opts.cwd, opts.sessionId, homeDir),
              },
            },
          }
        : { activeAgent: 'codex' as const, codexDiscovery: { cwd: realpathOrSelf(opts.cwd), spawnedAt: opts.spawnedAt } }
    // Create the sidecar dir first: a flight's per-stage dir (flightDir/<stage>)
    // is NOT pre-created by the store, so without this the write ENOENTs and the
    // catch below swallows it — the agent's session is orphaned (its JSONL still
    // lands in ~/.claude/projects, but no ref points the UI at it → a blank
    // Activity rail even though the agent ran). Idempotent for callers whose dir
    // already exists (benchmark, coverage).
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent-session.json'), JSON.stringify(file, null, 2))
  } catch {
    /* best-effort — the surface falls back to its empty state */
  }
}

export function resolveWorkflowAgentRef(dir: string, homeDir: string = os.homedir()): AgentSessionRef | null {
  let raw: string | null = null
  try { raw = fs.readFileSync(path.join(dir, 'agent-session.json'), 'utf-8') } catch { return null }
  // codex: discover the session by cwd + spawn time (the log path isn't pinned).
  const hint = readCodexDiscoveryHint(raw)
  if (hint) return locateCodexSessionLog(hint.cwd, hint.spawnedAt, homeDir)
  // claude: the persisted ref's logPath is cwd-derived, which can be wrong (the
  // project-dir slug folds more than `/`). Once the log exists, prefer locating
  // it by the globally-unique session id.
  const parsed = parseAgentSessionRefFile(raw)
  const ref = parsed ? selectAgentSessionRef(parsed) : null
  if (!ref) return null
  if (ref.logPath && fs.existsSync(ref.logPath)) return ref
  const found = ref.agent === 'claude' ? findClaudeLogBySessionId(ref.sessionId, homeDir) : null
  return found ? { ...ref, logPath: found } : ref
}

// Pick the agent (claude or codex) whose JSONL session log for this run is
// most recently modified on disk. Prefer this over the orchestrator-written
// `agent-session.json` when displaying history: that ref file is only
// updated when the heal loop cleans up cleanly, so a SIGKILL'd server or a
// locator miss leaves it pointing at a stale agent even when the other
// agent's logs are newer.
//
// Ties (e.g. only one agent's log exists, or mtimes are equal) prefer
// claude — that matches the legacy ref file's preference and keeps the
// display stable for single-agent runs.
export function locateMostRecentAgentSessionRef(
  runDir: string,
  homeDir: string = os.homedir(),
): AgentSessionRef | null {
  const claude = locateLatestClaudeSessionLog(runDir, homeDir)
  const codex = locateLatestCodexSessionLog(runDir, homeDir)
  const claudeMs = claude ? safeMtimeMs(claude.logPath) : 0
  const codexMs = codex ? safeMtimeMs(codex.logPath) : 0
  if (claudeMs === 0 && codexMs === 0) return null
  if (codexMs > claudeMs) return codex
  return claude
}

// ─── Reader / normalizer ───────────────────────────────────────────────────

// Read + normalize a session log in a single pass, returning both the timeline
// events and the session-level metadata (model/effort). Prefer this over
// calling `loadAgentSessionLog` + `loadAgentSessionMeta` separately so the file
// is only read and parsed once.
export function loadAgentSession(ref: AgentSessionRef): { events: AgentEvent[]; meta: AgentSessionMeta } {
  let raw: string
  try { raw = fs.readFileSync(ref.logPath, 'utf-8') } catch { return { events: [], meta: {} } }
  const events: AgentEvent[] = []
  const meta: AgentSessionMeta = {}
  for (const line of raw.split('\n')) {
    for (const ev of parseAgentSessionLine(ref.agent, line)) events.push(ev)
    applyAgentSessionMetaLine(ref.agent, line, meta)
  }
  return { events, meta }
}

export function loadAgentSessionLog(ref: AgentSessionRef): AgentEvent[] {
  return loadAgentSession(ref).events
}

// Extract just the session metadata. Used by the live WS handshake, which only
// needs model/effort and not the full event list.
export function loadAgentSessionMeta(ref: AgentSessionRef): AgentSessionMeta {
  let raw: string
  try { raw = fs.readFileSync(ref.logPath, 'utf-8') } catch { return {} }
  const meta: AgentSessionMeta = {}
  for (const line of raw.split('\n')) applyAgentSessionMetaLine(ref.agent, line, meta)
  return meta
}
