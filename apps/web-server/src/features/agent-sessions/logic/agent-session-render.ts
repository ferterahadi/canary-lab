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
import { AgentEvent, AgentSessionRef, loadAgentSessionLog } from './agent-session-log'

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
    fs.writeFileSync(file, `${transcript}\n`)
    return file
  } catch {
    return null
  }
}

export function renderAgentEventLine(event: AgentEvent, opts: { full?: boolean } = {}): string {
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
export function compactText(text: string, full = false): string {
  if (full) return text.trim()
  const compact = text.replace(/\s+/g, ' ').trim()
  const max = 1_200
  if (compact.length <= max) return compact
  return `${compact.slice(0, max)}...`
}
