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

export type AgentEvent =
  | { kind: 'user-message'; timestamp: string; text: string }
  | { kind: 'assistant-message'; timestamp: string; text: string }
  | { kind: 'assistant-thinking'; timestamp: string; text: string }
  | { kind: 'tool-call'; timestamp: string; toolId: string; name: string; input: unknown }
  | { kind: 'tool-result'; timestamp: string; toolId: string; output: string; isError?: boolean }

// ─── Claude locator ────────────────────────────────────────────────────────

// Claude encodes a project directory as the absolute path with every `/`
// replaced by `-`. So `/Users/oddle/foo` becomes `-Users-oddle-foo`. Dots,
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

// ─── Codex locator ─────────────────────────────────────────────────────────

interface CodexSessionMeta {
  id: string
  cwd: string
  timestamp: string
}

// First-line shape: `{ type: 'session_meta', timestamp, payload: { id, cwd, timestamp, ... } }`.
function readCodexSessionMeta(jsonlPath: string): CodexSessionMeta | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(jsonlPath, 'r')
    const buf = Buffer.alloc(8192)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf-8')
    const nl = text.indexOf('\n')
    const firstLine = nl >= 0 ? text.slice(0, nl) : text
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
    let entries: string[]
    try { entries = fs.readdirSync(dir) } catch { continue }
    for (const name of entries) {
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

// ─── Reader / normalizer ───────────────────────────────────────────────────

export function loadAgentSessionLog(ref: AgentSessionRef): AgentEvent[] {
  let raw: string
  try { raw = fs.readFileSync(ref.logPath, 'utf-8') } catch { return [] }
  const events: AgentEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { continue }
    if (!parsed || typeof parsed !== 'object') continue
    if (ref.agent === 'claude') {
      pushClaudeEvents(parsed as ClaudeLine, events)
    } else {
      pushCodexEvents(parsed as CodexLine, events)
    }
  }
  return events
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

function codexMessageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
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
