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
  | { kind: 'assistant-message'; timestamp: string; text: string }
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

// ─── Claude locator ────────────────────────────────────────────────────────

// Claude encodes a project directory as the absolute path with every `/`
// replaced by `-`. So `/Users/dev/foo` becomes `-Users-dev-foo`. Dots,
// hyphens, and underscores pass through. Verified against a live install.
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

export function locateClaudeSessionLog(
  runDir: string,
  sessionId: string,
  homeDir: string = os.homedir(),
): string | null {
  if (!sessionId) return null
  const encoded = encodeClaudeProjectDir(runDir)
  const candidate = path.join(homeDir, '.claude', 'projects', encoded, `${sessionId}.jsonl`)
  return fs.existsSync(candidate) ? candidate : null
}

// Locate a Claude session log by its (globally-unique) session id alone,
// scanning every project dir. Encoding-agnostic — Claude's project-dir slug
// isn't a pure `/`→`-` mapping (it also folds `_`→`-`, etc.), so when we know
// the cwd-derived path may be wrong we fall back to this.
export function findClaudeLogBySessionId(
  sessionId: string,
  homeDir: string = os.homedir(),
): string | null {
  if (!sessionId) return null
  const base = path.join(homeDir, '.claude', 'projects')
  let dirs: string[]
  try { dirs = fs.readdirSync(base) } catch { return null }
  for (const dir of dirs) {
    const candidate = path.join(base, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

// Find the newest Claude session for a run directory without requiring a
// sidecar session id. Older/interrupted runs can lack `agent-session-id.txt`,
// but Claude still writes JSONL logs under the encoded run directory.
export function locateLatestClaudeSessionLog(
  runDir: string,
  homeDir: string = os.homedir(),
): AgentSessionRef | null {
  const encoded = encodeClaudeProjectDir(runDir)
  const projectDir = path.join(homeDir, '.claude', 'projects', encoded)
  let best: { logPath: string; sessionId: string; mtimeMs: number } | null = null
  for (const name of readDirNames(projectDir)) {
    if (!name.endsWith('.jsonl')) continue
    const sessionId = name.slice(0, -'.jsonl'.length)
    if (!sessionId) continue
    const candidate = path.join(projectDir, name)
    let stat: fs.Stats
    try { stat = fs.statSync(candidate) } catch { continue }
    if (!stat.isFile()) continue
    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = { logPath: candidate, sessionId, mtimeMs: stat.mtimeMs }
    }
  }
  if (!best) return null
  return { agent: 'claude', sessionId: best.sessionId, logPath: best.logPath }
}

// ─── Codex locator ─────────────────────────────────────────────────────────

interface CodexSessionMeta {
  id: string
  cwd: string
  timestamp: string
}

// First-line shape: `{ type: 'session_meta', timestamp, payload: { id, cwd, timestamp, ... } }`.
//
// Codex 0.130+ embeds the full agent base-instructions prompt inside
// `payload.base_instructions.text`, which pushes the first JSONL line well
// past 100 KB. Read in chunks until we hit `\n` (or hit `MAX_FIRST_LINE`)
// instead of capping at a fixed buffer — a too-small buffer truncates the
// JSON and makes the locator silently return null for every real session.
function readCodexSessionMeta(jsonlPath: string): CodexSessionMeta | null {
  const firstLine = readFirstLine(jsonlPath)
  if (firstLine === null) return null
  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string
      payload?: { id?: unknown; cwd?: unknown; timestamp?: unknown }
    }
    if (parsed.type !== 'session_meta' || !parsed.payload) return null
    const { id, cwd, timestamp } = parsed.payload
    if (typeof id !== 'string' || typeof cwd !== 'string' || typeof timestamp !== 'string') return null
    return { id, cwd, timestamp }
  } catch {
    return null
  }
}

const FIRST_LINE_CHUNK_BYTES = 64 * 1024
const FIRST_LINE_MAX_BYTES = 2 * 1024 * 1024

function readFirstLine(jsonlPath: string): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(jsonlPath, 'r')
    const chunks: Buffer[] = []
    let total = 0
    while (total < FIRST_LINE_MAX_BYTES) {
      const buf = Buffer.alloc(FIRST_LINE_CHUNK_BYTES)
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      const slice = buf.subarray(0, n)
      const nl = slice.indexOf(0x0a)
      if (nl >= 0) {
        chunks.push(slice.subarray(0, nl))
        return Buffer.concat(chunks).toString('utf-8')
      }
      chunks.push(slice)
      total += n
    }
    return chunks.length > 0 ? Buffer.concat(chunks).toString('utf-8') : null
  } catch {
    return null
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* ignore */ }
  }
}

function realpathOrSelf(p: string): string {
  try { return fs.realpathSync(p) } catch { return p }
}

// Walk codex's date-bucketed session dirs from the cycle's start date through
// the next two days (covers UTC date rollover and unusually long cycles).
// Match by realpath(cwd) and timestamp >= cycleStartedAt. Return the newest
// match — heal agents are spawned sequentially, so there's typically one.
export function locateCodexSessionLog(
  runDir: string,
  cycleStartedAt: string,
  homeDir: string = os.homedir(),
): AgentSessionRef | null {
  const startMs = Date.parse(cycleStartedAt)
  if (!Number.isFinite(startMs)) return null
  const wantedCwd = realpathOrSelf(runDir)

  const sessionsRoot = path.join(homeDir, '.codex', 'sessions')
  if (!fs.existsSync(sessionsRoot)) return null

  const startDate = new Date(startMs)
  const datesToScan: Array<{ y: string; m: string; d: string }> = []
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const d = new Date(startDate.getTime() + dayOffset * 86_400_000)
    datesToScan.push({
      y: d.getUTCFullYear().toString().padStart(4, '0'),
      m: (d.getUTCMonth() + 1).toString().padStart(2, '0'),
      d: d.getUTCDate().toString().padStart(2, '0'),
    })
  }

  let best: { logPath: string; sessionId: string; ts: number } | null = null
  for (const { y, m, d } of datesToScan) {
    const dir = path.join(sessionsRoot, y, m, d)
    for (const name of readDirNames(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const candidate = path.join(dir, name)
      const meta = readCodexSessionMeta(candidate)
      if (!meta) continue
      const metaTs = Date.parse(meta.timestamp)
      if (!Number.isFinite(metaTs) || metaTs < startMs) continue
      if (realpathOrSelf(meta.cwd) !== wantedCwd) continue
      if (!best || metaTs > best.ts) {
        best = { logPath: candidate, sessionId: meta.id, ts: metaTs }
      }
    }
  }
  if (!best) return null
  return { agent: 'codex', sessionId: best.sessionId, logPath: best.logPath }
}

// Find the newest Codex session for a run directory without requiring a cycle
// start timestamp. Older/interrupted runs can lack the `agent-session-id.txt`
// sidecar; Codex's own JSONL session store is the only durable record in that
// case.
//
// Walks YYYY/MM/DD descending and stops at the first day with a cwd match.
// Bucket dates are zero-padded strings, so reverse-sorted lexical order is
// also reverse-sorted by date.
export function locateLatestCodexSessionLog(
  runDir: string,
  homeDir: string = os.homedir(),
): AgentSessionRef | null {
  const wantedCwd = realpathOrSelf(runDir)
  const sessionsRoot = path.join(homeDir, '.codex', 'sessions')

  // Codex filenames follow `rollout-<ISO-ts>-<id>.jsonl`, so lex-descending
  // order matches chronological order. Iterate newest-first and return on the
  // first cwd match — avoids reading every JSONL's first line when only the
  // newest one matters.
  for (const y of readDirNames(sessionsRoot).sort().reverse()) {
    const yearDir = path.join(sessionsRoot, y)
    for (const m of readDirNames(yearDir).sort().reverse()) {
      const monthDir = path.join(yearDir, m)
      for (const d of readDirNames(monthDir).sort().reverse()) {
        const dayDir = path.join(monthDir, d)
        for (const name of readDirNames(dayDir).sort().reverse()) {
          if (!name.endsWith('.jsonl')) continue
          const candidate = path.join(dayDir, name)
          const meta = readCodexSessionMeta(candidate)
          if (!meta) continue
          if (realpathOrSelf(meta.cwd) !== wantedCwd) continue
          if (!Number.isFinite(Date.parse(meta.timestamp))) continue
          return { agent: 'codex', sessionId: meta.id, logPath: candidate }
        }
      }
    }
  }
  return null
}

function readDirNames(dir: string): string[] {
  try { return fs.readdirSync(dir) } catch { return [] }
}

// Dispatch the per-agent "latest session for this run dir" locator. Each
// agent CLI stores its sessions under a different layout, so the two
// underlying functions can't share a path; this just selects between them.
export function locateLatestSessionLogForAgent(
  agent: AgentKind,
  runDir: string,
  homeDir: string = os.homedir(),
): AgentSessionRef | null {
  return agent === 'claude'
    ? locateLatestClaudeSessionLog(runDir, homeDir)
    : locateLatestCodexSessionLog(runDir, homeDir)
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

function safeMtimeMs(p: string): number {
  try { return fs.statSync(p).mtimeMs } catch { return 0 }
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

// Fold a single JSONL line into the accumulating session metadata. Last write
// wins, so the returned model/effort reflect the most recent record — a session
// that switches model mid-run shows where it ended up.
//   - codex: `{ type: 'turn_context', payload: { model, effort, summary } }`
//   - claude: `{ type: 'assistant', message: { model } }` (no effort concept)
function applyAgentSessionMetaLine(agent: AgentKind, line: string, meta: AgentSessionMeta): void {
  if (!line.trim()) return
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return }
  if (!parsed || typeof parsed !== 'object') return
  if (agent === 'codex') {
    const l = parsed as { type?: unknown; payload?: { model?: unknown; effort?: unknown } }
    if (l.type === 'turn_context' && l.payload && typeof l.payload === 'object') {
      if (typeof l.payload.model === 'string' && l.payload.model) meta.model = l.payload.model
      if (typeof l.payload.effort === 'string' && l.payload.effort) meta.effort = l.payload.effort
    }
    return
  }
  const l = parsed as { type?: unknown; message?: { model?: unknown } }
  if (l.type === 'assistant' && l.message && typeof l.message === 'object' && typeof l.message.model === 'string' && l.message.model) {
    meta.model = l.message.model
  }
}

// Parse a single JSONL line into 0..N normalized events. Shared by the batch
// loader above and the live tailer used by the structured-event WebSocket.
export function parseAgentSessionLine(agent: AgentKind, line: string): AgentEvent[] {
  if (!line.trim()) return []
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch { return [] }
  if (!parsed || typeof parsed !== 'object') return []
  const out: AgentEvent[] = []
  if (agent === 'claude') {
    pushClaudeEvents(parsed as ClaudeLine, out)
  } else {
    pushCodexEvents(parsed as CodexLine, out)
  }
  return out
}

export function renderAgentSessionContext(ref: AgentSessionRef, maxChars = 12_000): string {
  const events = loadAgentSessionLog(ref)
  if (events.length === 0) return ''

  const lines: string[] = [
    `Previous ${ref.agent} session ${ref.sessionId}:`,
  ]
  for (const event of events) {
    lines.push(renderAgentEventLine(event))
  }
  const rendered = lines.join('\n')
  // Point at a full transcript instead of the raw JSONL. The digest above caps
  // each event and the total; the transcript carries every event uncapped with
  // newlines preserved, but strips the JSONL envelope (tool schemas, base64
  // blobs, repeated system reminders) — losslessly cheaper for the agent to
  // Read than the raw log. Falls back to the raw log path on write failure.
  const fullPath = writeFullSessionTranscript(ref, events) ?? ref.logPath
  if (rendered.length <= maxChars) return `${rendered}\n[Full session transcript (untruncated): ${fullPath}]`
  return `${rendered.slice(0, maxChars)}\n[Previous session context truncated — full transcript: ${fullPath}]`
}

/**
 * Render the COMPLETE session as a plain-text transcript: every event, no
 * per-event or total cap, internal newlines preserved. This is the on-disk
 * companion the heal agent Reads when the in-prompt digest isn't enough — it
 * drops the JSONL envelope but keeps all the meaning, so it's a lossless
 * (token-cheaper) substitute for the raw `*.jsonl`.
 */
export function buildFullSessionTranscript(
  ref: AgentSessionRef,
  events: AgentEvent[] = loadAgentSessionLog(ref),
): string {
  if (events.length === 0) return ''
  const lines = [`Previous ${ref.agent} session ${ref.sessionId} (full transcript):`]
  for (const event of events) lines.push(renderAgentEventLine(event, { full: true }))
  return lines.join('\n\n')
}

/**
 * Materialize the full transcript next to the raw log (`<name>.transcript.txt`)
 * and return its path, or null if there's nothing to write / the write fails.
 */
export function writeFullSessionTranscript(
  ref: AgentSessionRef,
  events?: AgentEvent[],
): string | null {
  const transcript = buildFullSessionTranscript(ref, events)
  if (!transcript) return null
  const base = ref.logPath.endsWith('.jsonl')
    ? ref.logPath.slice(0, -'.jsonl'.length)
    : ref.logPath
  const file = `${base}.transcript.txt`
  try {
    fs.writeFileSync(file, transcript.endsWith('\n') ? transcript : `${transcript}\n`)
    return file
  } catch {
    return null
  }
}

function renderAgentEventLine(event: AgentEvent, opts: { full?: boolean } = {}): string {
  const prefix = event.timestamp ? `[${event.timestamp}] ` : ''
  const t = (s: string): string => compactText(s, opts.full)
  switch (event.kind) {
    case 'user-message':
      return `${prefix}USER: ${t(event.text)}`
    case 'assistant-message':
      return `${prefix}ASSISTANT: ${t(event.text)}`
    case 'assistant-thinking':
      return `${prefix}THINKING: ${t(event.text)}`
    case 'tool-call':
      return `${prefix}TOOL CALL ${event.name}: ${t(JSON.stringify(event.input))}`
    case 'tool-result': {
      const marker = event.isError ? ' ERROR' : ''
      return `${prefix}TOOL RESULT${marker}: ${t(event.output)}`
    }
  }
}

// Digest mode (full=false): collapse all whitespace to single spaces and cap at
// 1200 chars — one tight line per event for the in-prompt summary. Full mode
// (full=true): trim only, preserving internal newlines, with no length cap —
// for the on-disk transcript the agent Reads when the digest isn't enough.
function compactText(text: string, full = false): string {
  if (full) return text.trim()
  const compact = text.replace(/\s+/g, ' ').trim()
  const max = 1_200
  if (compact.length <= max) return compact
  return `${compact.slice(0, max)}...`
}

// ─── Claude normalization ──────────────────────────────────────────────────

interface ClaudeContentBlock {
  type?: string
  text?: unknown
  thinking?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}

interface ClaudeLine {
  type?: unknown
  timestamp?: unknown
  message?: { content?: unknown }
}

function pushClaudeEvents(line: ClaudeLine, out: AgentEvent[]): void {
  const ts = typeof line.timestamp === 'string' ? line.timestamp : ''
  if (line.type === 'user') {
    const content = line.message?.content
    if (typeof content === 'string') {
      if (content.trim()) out.push({ kind: 'user-message', timestamp: ts, text: content })
      return
    }
    if (Array.isArray(content)) {
      for (const block of content as ClaudeContentBlock[]) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          out.push({ kind: 'user-message', timestamp: ts, text: block.text })
        } else if (block?.type === 'tool_result') {
          out.push({
            kind: 'tool-result',
            timestamp: ts,
            toolId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
            output: stringifyClaudeToolResultContent(block.content),
            isError: block.is_error === true || undefined,
          })
        }
      }
    }
    return
  }
  if (line.type === 'assistant') {
    const content = line.message?.content
    if (!Array.isArray(content)) return
    for (const block of content as ClaudeContentBlock[]) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'assistant-message', timestamp: ts, text: block.text })
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        out.push({ kind: 'assistant-thinking', timestamp: ts, text: block.thinking })
      } else if (block?.type === 'tool_use') {
        out.push({
          kind: 'tool-call',
          timestamp: ts,
          toolId: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          input: block.input,
        })
      }
    }
    return
  }
  // Other top-level event types (last-prompt, permission-mode, file-history-
  // snapshot, attachment-only events) carry no user-facing content for the
  // structured view — drop them.
}

function stringifyClaudeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  // Claude tool_result content can be a mixed array of text + image blocks.
  // Concatenate text blocks; replace others with a placeholder so the UI
  // doesn't show an empty result for an image-only output.
  const parts: string[] = []
  for (const block of content as Array<{ type?: string; text?: unknown }>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block?.type === 'image') {
      parts.push('[image]')
    }
  }
  return parts.join('\n')
}

// ─── Codex normalization ───────────────────────────────────────────────────

interface CodexPayload {
  type?: string
  role?: string
  content?: unknown
  name?: unknown
  arguments?: unknown
  call_id?: unknown
  output?: unknown
  phase?: unknown
}

interface CodexLine {
  timestamp?: unknown
  type?: unknown
  payload?: CodexPayload
}

function pushCodexEvents(line: CodexLine, out: AgentEvent[]): void {
  if (line.type !== 'response_item' || !line.payload) return
  const ts = typeof line.timestamp === 'string' ? line.timestamp : ''
  const p = line.payload
  if (p.type === 'message') {
    // Skip auto-injected developer messages (sandbox/permissions instructions)
    // and the canned environment-context bootstrap. They're machine
    // bookkeeping, not user-meaningful turns.
    if (p.role === 'developer') return
    if (!Array.isArray(p.content)) return
    const text = codexMessageText(p.content)
    if (!text.trim()) return
    if (p.role === 'user') {
      if (/^<environment_context>/.test(text.trim())) return
      out.push({ kind: 'user-message', timestamp: ts, text })
    } else if (p.role === 'assistant') {
      out.push({ kind: 'assistant-message', timestamp: ts, text })
    }
    return
  }
  if (p.type === 'function_call') {
    const args = typeof p.arguments === 'string' ? safeJsonParse(p.arguments) : p.arguments
    out.push({
      kind: 'tool-call',
      timestamp: ts,
      toolId: typeof p.call_id === 'string' ? p.call_id : '',
      name: typeof p.name === 'string' ? p.name : '',
      input: args,
    })
    return
  }
  if (p.type === 'function_call_output') {
    out.push({
      kind: 'tool-result',
      timestamp: ts,
      toolId: typeof p.call_id === 'string' ? p.call_id : '',
      output: typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? ''),
    })
    return
  }
  // `reasoning` payloads carry encrypted/empty content for non-owners; skip.
}

function codexMessageText(content: unknown[]): string {
  const parts: string[] = []
  for (const block of content as Array<{ type?: string; text?: unknown }>) {
    if ((block?.type === 'input_text' || block?.type === 'output_text') && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}
