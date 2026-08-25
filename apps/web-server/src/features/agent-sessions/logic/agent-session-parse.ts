import path from 'path'
import type { AgentEvent, AgentKind, AgentSessionMeta } from './agent-session-log'

// Fold a single JSONL line into the accumulating session metadata. Last write
// wins, so the returned model/effort reflect the most recent record — a session
// that switches model mid-run shows where it ended up.
//   - codex: `{ type: 'turn_context', payload: { model, effort, summary } }`
//   - claude: `{ type: 'assistant', message: { model } }` (no effort concept)
export function applyAgentSessionMetaLine(agent: AgentKind, line: string, meta: AgentSessionMeta): void {
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

// ─── Claude normalization ──────────────────────────────────────────────────

export interface ClaudeContentBlock {
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

export interface ClaudeLine {
  type?: unknown
  timestamp?: unknown
  isApiErrorMessage?: unknown
  message?: { content?: unknown }
}

// Harness bookkeeping the CLI injects as `user` turns: background-task
// completions, slash-command envelopes, local-command stdout. They are not the
// prompt and not the agent's reasoning, so they'd read as noise on the
// timeline — a `<task-notification>` XML blob rendered as a user message is
// the symptom that prompted this. Matched against a known tag set rather than
// "any leading <tag>" so a genuine pasted HTML/XML prompt still shows.
// Mirrors the codex path's `<environment_context>` skip.
export const CLAUDE_INJECTED_TAGS = [
  'task-notification',
  'command-message',
  'command-name',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'system-reminder',
] as const

export function isInjectedClaudeUserText(text: string): boolean {
  const head = text.trimStart()
  return CLAUDE_INJECTED_TAGS.some((tag) => head.startsWith(`<${tag}>`))
}

export function pushClaudeEvents(line: ClaudeLine, out: AgentEvent[]): void {
  const ts = typeof line.timestamp === 'string' ? line.timestamp : ''
  if (line.type === 'user') {
    const content = line.message?.content
    if (typeof content === 'string') {
      if (content.trim() && !isInjectedClaudeUserText(content)) {
        out.push({ kind: 'user-message', timestamp: ts, text: content })
      }
      return
    }
    if (Array.isArray(content)) {
      for (const block of content as ClaudeContentBlock[]) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          if (!isInjectedClaudeUserText(block.text)) {
            out.push({ kind: 'user-message', timestamp: ts, text: block.text })
          }
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
    const apiError = line.isApiErrorMessage === true ? true : undefined
    for (const block of content as ClaudeContentBlock[]) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'assistant-message', timestamp: ts, text: block.text, apiError })
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

export function stringifyClaudeToolResultContent(content: unknown): string {
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

export interface CodexPayload {
  type?: string
  role?: string
  content?: unknown
  name?: unknown
  arguments?: unknown
  call_id?: unknown
  output?: unknown
  phase?: unknown
}

export interface CodexLine {
  timestamp?: unknown
  type?: unknown
  payload?: CodexPayload
}

export function pushCodexEvents(line: CodexLine, out: AgentEvent[]): void {
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

export function codexMessageText(content: unknown[]): string {
  const parts: string[] = []
  for (const block of content as Array<{ type?: string; text?: unknown }>) {
    if ((block?.type === 'input_text' || block?.type === 'output_text') && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

export function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}
