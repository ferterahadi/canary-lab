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
import path from 'path'
import { AgentEvent, AgentKind, AgentSessionRef, loadAgentSession } from './agent-session-log'
import { parseAgentSessionLine } from './agent-session-parse'
import { readDirNames } from './agent-session-paths'

// ─── Subagent threads (claude only) ────────────────────────────────────────
//
// When a claude session spawns subagents (the `Agent`/`Task` tool), each child
// gets its own JSONL beside the parent's log:
//
//   <parent-log-dir>/<session-uuid>/subagents/agent-<id>.jsonl
//   <parent-log-dir>/<session-uuid>/subagents/agent-<id>.meta.json
//
// The meta carries `toolUseId` — the exact `id` of the parent's `tool_use`
// block — so a child thread joins to its parent row by key, with no timestamp
// correlation or name matching. The child JSONL is the same claude format, so
// it reuses `parseAgentSessionLine` unchanged.
//
// Codex has no subagent concept; these functions return empty for it, which is
// why callers can invoke them unconditionally.

export interface SubagentThread {
  agentId: string
  /** The parent `tool-call` event's `toolId` this thread hangs under. */
  parentToolId: string
  agentType: string
  description: string
  spawnDepth: number
  logPath: string
  events: AgentEvent[]
}

/** The `subagents/` dir for a session log, or null if the agent can't have one. */
export function subagentDirFor(ref: AgentSessionRef): string | null {
  if (ref.agent !== 'claude' || !ref.logPath) return null
  const base = ref.logPath.endsWith('.jsonl')
    ? ref.logPath.slice(0, -'.jsonl'.length)
    : ref.logPath
  return path.join(base, 'subagents')
}

export function readSubagentMeta(metaPath: string): {
  agentType: string
  description: string
  toolUseId: string
  spawnDepth: number
} | null {
  let raw: string
  try { raw = fs.readFileSync(metaPath, 'utf-8') } catch { return null }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const m = parsed as { agentType?: unknown; description?: unknown; toolUseId?: unknown; spawnDepth?: unknown }
  // `toolUseId` is the join key — a thread without one can't be placed under a
  // parent row, so it's dropped rather than rendered at an arbitrary position.
  if (typeof m.toolUseId !== 'string' || !m.toolUseId) return null
  return {
    agentType: typeof m.agentType === 'string' ? m.agentType : 'agent',
    description: typeof m.description === 'string' ? m.description : '',
    toolUseId: m.toolUseId,
    spawnDepth: typeof m.spawnDepth === 'number' ? m.spawnDepth : 1,
  }
}

/** Parse one subagent thread from its jsonl path (meta sits beside it). */
export function loadSubagentThread(jsonlPath: string): SubagentThread | null {
  if (!jsonlPath.endsWith('.jsonl')) return null
  const meta = readSubagentMeta(`${jsonlPath.slice(0, -'.jsonl'.length)}.meta.json`)
  if (!meta) return null
  let raw: string
  try { raw = fs.readFileSync(jsonlPath, 'utf-8') } catch { return null }
  const events: AgentEvent[] = []
  for (const line of raw.split('\n')) {
    // Children of a claude session are always claude-format, regardless of
    // which agent the caller thinks it's reading.
    for (const ev of parseAgentSessionLine('claude', line)) events.push(ev)
  }
  return {
    agentId: path.basename(jsonlPath, '.jsonl'),
    parentToolId: meta.toolUseId,
    agentType: meta.agentType,
    description: meta.description,
    spawnDepth: meta.spawnDepth,
    logPath: jsonlPath,
    events,
  }
}

/** The full REST snapshot for a session: its own timeline, its metadata, and
 *  every subagent thread it spawned. Every `/agent-session` endpoint returns
 *  this exact shape, so a new field reaches all of them at once. */
export function buildAgentSessionResponse(ref: AgentSessionRef): {
  agent: AgentKind
  sessionId: string
  model?: string
  effort?: string
  events: AgentEvent[]
  subagents: SubagentThread[]
} {
  const { events, meta } = loadAgentSession(ref)
  return {
    agent: ref.agent,
    sessionId: ref.sessionId,
    model: meta.model,
    effort: meta.effort,
    events,
    subagents: loadSubagentThreads(ref),
  }
}

/** Every subagent thread spawned by a session, in stable (agentId) order. */
export function loadSubagentThreads(ref: AgentSessionRef): SubagentThread[] {
  const dir = subagentDirFor(ref)
  if (!dir) return []
  const out: SubagentThread[] = []
  for (const name of readDirNames(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue
    const thread = loadSubagentThread(path.join(dir, name))
    if (thread) out.push(thread)
  }
  return out
}
