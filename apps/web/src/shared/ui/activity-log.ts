import type { AgentSessionEvent, SubagentThread } from '@shared/agent-session-types'
import { formatElapsedSeconds } from '@/shared/lib/format'
import type { CodeLanguage } from './code-highlighter'
import type { ExternalClientKind } from './external-client-branding'

// What one Activity row says at rest, derived from the entry it stands for.
// Every row — a conductor line, an agent event, the task prompt, an external
// session's lifecycle — reduces to the same four facts, so the rail renders one
// row shape and the modal carries everything the row had to leave out.

/** Who produced the entry. `prompt` is the task handed TO the agent; `agent` is
 *  anything the agent emitted (tool calls, results, prose, thinking); `system`
 *  is Canary's own record (conductor lines, external-session lifecycle). */
export type LogKind = 'system' | 'agent' | 'prompt'

export interface LogLine {
  kind: LogKind
  /** The short noun or tool name in the row's bold column. */
  verb: string
  /** One line of the entry's content, or of its target for a tool call. */
  summary: string
  danger?: boolean
  /** The summary IS the whole entry — a one-liner the row already shows in
   *  full. Such a row opens nothing: a modal repeating the row is noise. */
  whole?: boolean
}

/** True when the row's one-line summary is the text itself, uncut. */
function showsAll(text: string, summary: string): boolean {
  return text.trim() === summary
}

export const LOG_KIND_LABEL: Record<LogKind, string> = { system: 'System', agent: 'Agent', prompt: 'Prompt' }

/** The first non-blank line, trimmed and capped — a row is one line tall. */
export function firstLineOf(text: string, max = 160): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function shortSession(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id
}

/** An MCP tool's full name carries its server (`mcp__canary_lab__get_flight`);
 *  the row has room for the verb only. The modal still shows the full name. */
export function toolVerb(name: string): string {
  if (!name) return 'tool'
  return name.startsWith('mcp__') ? name.split('__').at(-1) || name : name
}

const TARGET_KEYS = ['file_path', 'path', 'cmd', 'command', 'pattern', 'query', 'url']

export function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return firstLineOf(input.replace(/\s+/g, ' '), 80)
  if (typeof input !== 'object') return String(input)
  const obj = input as Record<string, unknown>
  for (const key of TARGET_KEYS) {
    const value = obj[key]
    if (typeof value === 'string' && value) return value.length > 80 ? `${value.slice(0, 79)}…` : value
  }
  const json = JSON.stringify(obj)
  return json.length > 80 ? `${json.slice(0, 79)}…` : json
}

export function formatJson(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

/** The file a tool call read or wrote, when its input names one. */
export function toolFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const obj = input as Record<string, unknown>
  const path = obj.file_path ?? obj.path
  return typeof path === 'string' && path ? path : undefined
}

/** How long a list of events spans, first to last stamp; '' under two stamps. */
export function eventSpan(events: readonly AgentSessionEvent[]): string {
  const stamps = events.map((e) => Date.parse(e.timestamp)).filter((n) => Number.isFinite(n))
  if (stamps.length < 2) return ''
  return formatElapsedSeconds((Math.max(...stamps) - Math.min(...stamps)) / 1000)
}

export function isoSpan(startIso: string | undefined, endIso: string | undefined): string | null {
  const start = Date.parse(startIso ?? '')
  const end = Date.parse(endIso ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return formatElapsedSeconds((end - start) / 1000)
}

export function subagentSummary(threads: readonly SubagentThread[]): string {
  const [first] = threads
  const events = first.events.filter(Boolean)
  const parts = [first.agentType, first.description, `${events.length} event${events.length === 1 ? '' : 's'}`, eventSpan(events)]
  const more = threads.length > 1 ? ` · +${threads.length - 1} more` : ''
  return parts.filter(Boolean).join(' · ') + more
}

/** A call shows all of itself when its input is the one target the row
 *  already prints — `Read {file_path}` — under a tool name the row prints
 *  unshortened. Any other argument (an offset, a description) is left out of
 *  the row, so the call opens. */
function callShowsAll(name: string, input: unknown): boolean {
  if (toolVerb(name) !== name || !input || typeof input !== 'object') return false
  const entries = Object.entries(input)
  if (entries.length !== 1) return false
  const [key, value] = entries[0]
  return TARGET_KEYS.includes(key) && typeof value === 'string' && !value.includes('\n') && summarizeInput(input) === value
}

function textLine(kind: LogKind, verb: string, text: string, danger = false): LogLine {
  const summary = firstLineOf(text)
  return { kind, verb, summary, ...(danger ? { danger: true } : {}), ...(showsAll(text, summary) ? { whole: true } : {}) }
}

export function describeEvent(event: AgentSessionEvent, threads?: readonly SubagentThread[]): LogLine {
  switch (event.kind) {
    case 'user-message': {
      const summary = firstLineOf(promptBody(event.text)) || firstLineOf(event.text)
      return { kind: 'prompt', verb: 'Instructions', summary, ...(showsAll(event.text, summary) ? { whole: true } : {}) }
    }
    case 'assistant-message':
      return event.apiError ? textLine('agent', 'API error', event.text, true) : textLine('agent', 'Assistant', event.text)
    case 'assistant-thinking':
      return textLine('agent', 'Thinking', event.text)
    case 'tool-call':
      return threads?.length
        ? { kind: 'agent', verb: 'Subagent', summary: subagentSummary(threads) }
        : { kind: 'agent', verb: toolVerb(event.name), summary: summarizeInput(event.input), ...(callShowsAll(event.name, event.input) ? { whole: true } : {}) }
    case 'tool-result': {
      // A numbered file read previews its first line without the line number,
      // which said nothing the row needs.
      const numbered = numberedLines(event.output)
      const text = numbered ? numbered.lines.join('\n') : event.output
      const summary = firstLineOf(text) || '(empty)'
      const whole = !event.output.trim() || showsAll(event.output, summary)
      return { kind: 'agent', verb: event.isError ? 'Error' : 'Result', summary, ...(event.isError ? { danger: true } : {}), ...(whole ? { whole: true } : {}) }
    }
  }
}

/** A task prompt can open with harness boilerplate wrapped in tags
 *  (`<recommended_plugins>…</recommended_plugins>`); the row previews the task
 *  after it. The modal still shows the prompt whole. */
export function promptBody(text: string): string {
  let rest = text
  for (;;) {
    const block = /^\s*<([a-z][\w-]*)>[\s\S]*?<\/\1>/i.exec(rest)
    if (!block) return rest
    rest = rest.slice(block[0].length)
  }
}

/** One conductor line, `[tag@<iso>] text`. The stamp is optional: lines
 *  written before the conductor stamped them (older flights) still parse, just
 *  undated; an untagged line is all text. */
export interface SystemLine {
  tag?: string
  timestamp?: string
  text: string
}

export function parseSystemLine(line: string): SystemLine {
  const match = /^\[([\w-]+)(?:@([^\]]+))?\]\s?([\s\S]*)$/.exec(line)
  if (!match) return { text: line }
  return { tag: match[1], ...(match[2] ? { timestamp: match[2] } : {}), text: match[3] }
}

/** A short, stable key for a line of any length (FNV-1a, base 36). */
export function textKey(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** Shared by timeline rows and links that open a recorded system entry. */
export function systemLogId(line: string, occurrence = 0): string {
  return `system:${textKey(line)}:${occurrence}`
}

/** A conductor tag reads as a word in the verb column (`coverage` → Coverage). */
export function systemVerb(tag: string | undefined): string {
  if (!tag) return 'System'
  return tag.charAt(0).toUpperCase() + tag.slice(1)
}

export type ExternalLifecycleStatus = 'running' | 'ready' | 'done' | 'failed' | 'aborted'

/** Work an external client (Claude / Codex over MCP) did for a stage. Canary
 *  holds no transcript for it — only the lifecycle the client reported. */
export interface ExternalSessionActivity {
  taskId?: string
  actionLabel?: string
  clientKind: ExternalClientKind
  sessionId?: string
  status: ExternalLifecycleStatus
  message: string
  startedAt?: string
  endedAt?: string
  conversationName?: string
  sessionUrl?: string
}

export function externalLifecycle(status: ExternalLifecycleStatus, phase: 'start' | 'end'): string {
  if (phase === 'start') return status === 'running' ? 'Running' : 'Started'
  if (status === 'ready') return 'Result ready'
  if (status === 'done') return 'Completed'
  if (status === 'failed') return 'Failed'
  return 'Stopped'
}

/** A Read result arrives as `cat -n` output: `N\t` (current Claude CLI) or
 *  `   N→` (older builds) before every line. Split the numbers into their own
 *  gutter so a wrapped line hangs under its text, not under its number. Only the
 *  leading run counts — the CLI can append a reminder block after the file —
 *  and anything after the run is returned as `tail`. */
export function numberedLines(output: string): { numbers: number[]; lines: string[]; tail: string } | null {
  const rows = output.split('\n')
  const numbers: number[] = []
  const lines: string[] = []
  let at = 0
  for (; at < rows.length; at += 1) {
    const match = /^\s*(\d+)(?:\t|→)(.*)$/.exec(rows[at])
    if (!match) break
    numbers.push(Number(match[1]))
    lines.push(match[2])
  }
  if (numbers.length === 0) return null
  return { numbers, lines, tail: rows.slice(at).join('\n').trim() }
}

const EXTENSION_LANGUAGE: Record<string, CodeLanguage> = {
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  json: 'json', jsonl: 'json',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', js: 'typescript', mjs: 'typescript', cjs: 'typescript',
  tsx: 'tsx', jsx: 'tsx',
  yml: 'yaml', yaml: 'yaml',
}

/** The grammar to colour a payload with: the file's extension when the call
 *  named a file, else JSON when the text parses as an object or array. Null
 *  means plain text — a wrong grammar is worse than none. */
export function languageFor(path: string | undefined, text: string): CodeLanguage | null {
  const ext = path ? /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() : undefined
  if (ext) return EXTENSION_LANGUAGE[ext] ?? null
  const trimmed = text.trim()
  if (!/^[[{]/.test(trimmed)) return null
  try {
    JSON.parse(trimmed)
    return 'json'
  } catch {
    return null
  }
}
