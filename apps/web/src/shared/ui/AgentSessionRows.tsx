import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentSessionEvent, SubagentThread } from '@/shared/api/client'

// ─── Timeline rows ───────────────────────────────────────────────────────────
// Each event is a node on a single vertical rail: a typed marker (role/tool
// glyph) + its content. Tool calls/results collapse to one mono line and
// disclose their full payload; prose reads as a clean transcript.

export function EventRow({ event, subagents }: { event: AgentSessionEvent; subagents?: Map<string, SubagentThread[]> }) {
  return (
    <li className="agentts-row" data-kind={event.kind}>
      <NodeMarker event={event} />
      <EventBody event={event} subagents={subagents} />
    </li>
  )
}

/** A run of consecutive conductor lines sharing one `[TAG]` (untagged lines
 *  group under `tag: undefined`). Exact repeats inside the run collapse to one
 *  entry with a count — the conductor re-announces the same state often. */
export type SystemGroup = {
  tag?: string
  /** The earliest STAMPED line in the run — the group heads on it, the way an
   *  agent row heads on its event time. A run can mix undated lines (written
   *  before the conductor stamped them) with dated ones when a flight spans the
   *  change: the head takes the first timestamp it finds, so the group is dated
   *  as long as ANY line in it is. Absent only when every line is unstamped. */
  timestamp?: string
  entries: Array<{ text: string; count: number }>
}

/** Same-tag lines this far apart are separate visits to the stage (a resume /
 *  retry days later), not one burst of output — the run splits so each visit
 *  heads on its own time. Without the split, a stage log that accumulated
 *  re-entries (portify's `workflow … started` per attempt) renders every start
 *  under the FIRST stamp, dating today's workflow with yesterday's clock. */
export const SYSTEM_GROUP_SPLIT_MS = 60_000

/** Fold `[TAG] text` lines into tag-runs so the tag prints once per run and
 *  identical consecutive lines show as `×N` instead of stacking. A run breaks
 *  on a tag change OR a stamp gap over `SYSTEM_GROUP_SPLIT_MS` — see above. */
export function groupSystemLines(lines: string[]): SystemGroup[] {
  const groups: SystemGroup[] = []
  // Last stamped instant in the current group — the gap baseline. Undefined
  // while a group has only unstamped lines (no gap is computable there, so
  // undated runs never split; they group exactly as before).
  let lastStampMs: number | undefined
  for (const line of lines) {
    // `[tag@<iso>] text` — the stamp is optional: lines written before the
    // conductor stamped them (older flights) still parse, just undated.
    const m = /^\[([\w-]+)(?:@([^\]]+))?\]\s?(.*)$/.exec(line)
    const tag = m?.[1]
    const timestamp = m?.[2]
    const text = m ? m[3] : line
    const stampMs = timestamp !== undefined ? Date.parse(timestamp) : NaN
    const last = groups[groups.length - 1]
    const reentry =
      lastStampMs !== undefined && !Number.isNaN(stampMs) && stampMs - lastStampMs > SYSTEM_GROUP_SPLIT_MS
    if (!last || last.tag !== tag || reentry) {
      groups.push({ tag, timestamp, entries: [{ text, count: 1 }] })
      lastStampMs = Number.isNaN(stampMs) ? undefined : stampMs
      continue
    }
    // Backfill the head time from a later line when the run opened undated —
    // a flight that spanned the stamping change has undated lines first, then
    // stamped ones; without this the whole run reads as timeless.
    if (last.timestamp === undefined && timestamp !== undefined) last.timestamp = timestamp
    if (!Number.isNaN(stampMs)) lastStampMs = stampMs
    const lastEntry = last.entries[last.entries.length - 1]
    if (lastEntry.text === text) lastEntry.count += 1
    else last.entries.push({ text, count: 1 })
  }
  return groups
}

// A run of conductor system lines on the same rail as the agent events, in the
// same left gutter (boxy terminal node + shared thread line) so it reads as one
// timeline. No band, no chip: mono type at the agent's own size, in muted
// colour, is the whole distinction — the agent's prose stays the loudest thing.
export function SystemRow({ group }: { group: SystemGroup }) {
  return (
    <li className="agentts-sysrow">
      <span className="agentts-sysnode" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 4.5l3 3-3 3" />
          <path d="M8.5 11h4.5" />
        </svg>
      </span>
      <div className="agentts-sysbody">
        {/* The tag heads the run on its own line — same shape as an agent row's
            head (label above, body below) so system and agent rows read as one
            rail instead of two layouts. */}
        {group.tag !== undefined && (
          <div className="agentts-rowhead">
            <span className="agentts-label agentts-systag">{group.tag}</span>
            {group.timestamp && <Timestamp value={group.timestamp} />}
          </div>
        )}
        {group.entries.map((entry, idx) => (
          <div className="agentts-sysline" key={idx}>
            <span className="agentts-systext">
              {entry.text}
              {entry.count > 1 && <span className="agentts-sysrepeat">×{entry.count}</span>}
            </span>
          </div>
        ))}
      </div>
    </li>
  )
}

export const NODE_ACCENT: Record<AgentSessionEvent['kind'], string> = {
  'user-message': 'var(--boot)',
  'assistant-message': 'var(--assistant)',
  'assistant-thinking': 'var(--text-muted)',
  'tool-call': 'var(--warning)',
  'tool-result': 'var(--text-muted)',
}

export function NodeMarker({ event }: { event: AgentSessionEvent }) {
  const isError = event.kind === 'tool-result' && event.isError === true
  const accent = isError ? 'var(--danger)' : NODE_ACCENT[event.kind]
  const filled = event.kind === 'user-message' || event.kind === 'assistant-message'
  return (
    <span
      className="agentts-node"
      aria-hidden="true"
      style={{ borderColor: accent, color: filled ? 'var(--bg-base)' : accent, background: filled ? accent : 'var(--bg-base)' }}
    >
      <NodeGlyph event={event} />
    </span>
  )
}

export function NodeGlyph({ event }: { event: AgentSessionEvent }) {
  if (event.kind === 'tool-call') return <NodeSvg>{toolGlyph(event.name)}</NodeSvg>
  if (event.kind === 'tool-result') {
    return <NodeSvg>{event.isError ? <path d="M5 5l6 6M11 5l-6 6" /> : <path d="M3.5 8.5l3 3 6-6.5" />}</NodeSvg>
  }
  if (event.kind === 'user-message') return <NodeSvg><path d="M6 4l4 4-4 4" /></NodeSvg>
  return null // assistant + thinking → the filled/hollow dot is enough
}

export function NodeSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

export function EventBody({ event, subagents }: { event: AgentSessionEvent; subagents?: Map<string, SubagentThread[]> }) {
  switch (event.kind) {
    case 'user-message':
      return <PromptBody text={event.text} timestamp={event.timestamp} />
    case 'assistant-message':
      return event.apiError
        ? <ApiErrorBody text={event.text} timestamp={event.timestamp} />
        : <ProseBody label="Assistant" text={event.text} timestamp={event.timestamp} />
    case 'assistant-thinking':
      return <ThinkingBody text={event.text} timestamp={event.timestamp} />
    case 'tool-call':
      return (
        <ToolCallBody
          name={event.name}
          input={event.input}
          timestamp={event.timestamp}
          toolId={event.toolId}
          threads={subagents?.get(event.toolId)}
        />
      )
    case 'tool-result':
      return <ToolResultBody output={event.output} isError={event.isError} timestamp={event.timestamp} toolId={event.toolId} />
  }
}

/** A turn the CLI synthesized after the model's stream dropped. Rendered as a
 *  termination rather than prose: the text that came with it is recovered
 *  partial output, and reading it as the agent's conclusion is exactly the
 *  mistake this row exists to prevent. */
export function ApiErrorBody({ text, timestamp }: { text: string; timestamp: string }) {
  return (
    <>
      <div className="agentts-rowhead">
        <span className="agentts-label" style={{ color: 'var(--danger)' }}>Terminated · API error</span>
        <Timestamp value={timestamp} />
      </div>
      <div className="agentts-prose" style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{firstLineOf(text)}</div>
    </>
  )
}

export function firstLineOf(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

export function RowHead({ label, timestamp }: { label: string; timestamp: string }) {
  return (
    <div className="agentts-rowhead">
      <span className="agentts-label">{label}</span>
      <Timestamp value={timestamp} />
    </div>
  )
}

export function ProseBody({ label, text, timestamp }: { label: string; text: string; timestamp: string }) {
  return (
    <>
      <RowHead label={label} timestamp={timestamp} />
      <Markdown text={text} />
    </>
  )
}

// Assistant/prompt prose is genuine markdown (headers, GFM tables, status
// bullets, inline code). Render it as such; tool payloads stay raw <pre>.
// react-markdown does not emit raw HTML by default, so untrusted-ish agent
// output can't inject markup.
export function Markdown({ text }: { text: string }) {
  return (
    <div className="agentts-prose agentts-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

export const CLAMP_3: React.CSSProperties = {
  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
}

export function PromptBody({ text, timestamp }: { text: string; timestamp: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 260
  // Collapsed preview stays plain text — `-webkit-line-clamp` only clamps
  // inline content, so it can't truncate markdown's block children. The
  // expanded view renders the full markdown.
  return (
    <>
      <RowHead label="Prompt" timestamp={timestamp} />
      {!expanded && long
        ? <div className="agentts-prose" style={CLAMP_3}>{text}</div>
        : <Markdown text={text} />}
      {long && (
        <button type="button" className="agentts-morebtn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  )
}

export function ThinkingBody({ text, timestamp }: { text: string; timestamp: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="agentts-think">
      <button type="button" className="agentts-thinkbtn" onClick={() => setExpanded((v) => !v)}>
        <Chevron open={expanded} />
        <span>Thinking</span>
        <Timestamp value={timestamp} />
      </button>
      {expanded && <div className="agentts-thinkbody agentts-md">{text && <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>}</div>}
    </div>
  )
}

export function ToolCallBody({ name, input, timestamp, toolId, threads }: {
  name: string
  input: unknown
  timestamp: string
  toolId: string
  threads?: SubagentThread[]
}) {
  const [expanded, setExpanded] = useState(false)
  const target = summarizeInput(input)
  return (
    <>
      <RowHead label="Tool call" timestamp={timestamp} />
      <div className="agentts-tool">
        <button type="button" className="agentts-toolbtn" onClick={() => setExpanded((v) => !v)} title={toolId}>
          <span className="agentts-toolname">{name || 'tool'}</span>
          {target && <span className="agentts-tooltarget">{target}</span>}
          <Chevron open={expanded} className="agentts-chev" />
        </button>
        {expanded && <pre className="agentts-pre">{formatJson(input)}</pre>}
        {/* Spawned children hang below the input disclosure as siblings, not
            inside it: "what did it do" and "what were its args" are separate
            questions, and gating the timeline behind the JSON would bury the
            one that matters. */}
        {(threads ?? []).map((thread) => (
          <SubagentThreadRow key={thread.agentId} thread={thread} />
        ))}
      </div>
    </>
  )
}

/** How long a thread ran, from its first to its last event. */
export function threadDuration(events: AgentSessionEvent[]): string {
  const stamps = events.map((e) => Date.parse(e.timestamp)).filter((n) => Number.isFinite(n))
  if (stamps.length < 2) return ''
  const secs = Math.round((Math.max(...stamps) - Math.min(...stamps)) / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

/** One spawned subagent, disclosed inside its parent's tool-call box. Collapsed
 *  by default — a finished child's conclusion already reached the parent rail —
 *  except when it's still running or died, which are the two cases where the
 *  parent rail alone leaves the user guessing. */
export function SubagentThreadRow({ thread }: { thread: SubagentThread }) {
  const events = thread.events.filter(Boolean)
  const failed = events.some((e) => e.kind === 'assistant-message' && e.apiError)
  // A thread whose last event is a tool call is mid-flight: the result that
  // would close it hasn't been written yet.
  const running = !failed && events.length > 0 && events[events.length - 1].kind === 'tool-call'
  const [expanded, setExpanded] = useState(running || failed)
  const duration = threadDuration(events)
  return (
    <div className="agentts-sub">
      <button type="button" className="agentts-subbtn" onClick={() => setExpanded((v) => !v)}>
        {running && <span className="agentts-sublive" aria-hidden="true" />}
        <span className="agentts-subtype">{thread.agentType}</span>
        <span className="agentts-submeta">
          {events.length} event{events.length === 1 ? '' : 's'}
          {duration && ` · ${duration}`}
          {failed ? ' · terminated' : running ? '' : ' · done'}
        </span>
        <Chevron open={expanded} className="agentts-chev" />
      </button>
      {expanded && (
        <ol className="agentts-nest">
          {events.map((event, idx) => (
            // Depth stops here: a subagent's own children would nest a third
            // rail inside an already-indented one, which stops being readable
            // long before it stops being possible.
            <li key={idx} className="agentts-row agentts-nestrow" data-kind={event.kind}>
              <NodeMarker event={event} />
              <EventBody event={event} />
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function ToolResultBody({ output, isError, timestamp, toolId }: { output: string; isError?: boolean; timestamp: string; toolId: string }) {
  const [expanded, setExpanded] = useState(false)
  const firstLine = output.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  const preview = firstLine.length > 140 ? firstLine.slice(0, 137) + '…' : firstLine
  return (
    <>
      <RowHead label={isError ? 'Tool error' : 'Result'} timestamp={timestamp} />
      <div className="agentts-tool" style={isError ? { borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border-default))' } : undefined}>
        <button type="button" className="agentts-toolbtn" onClick={() => setExpanded((v) => !v)} title={toolId}>
          <span className="agentts-tooltarget" style={{ color: isError ? 'var(--danger)' : 'var(--text-secondary)' }}>
            {preview || '(empty)'}
          </span>
          <Chevron open={expanded} className="agentts-chev" />
        </button>
        {expanded && <pre className="agentts-pre">{output || '(empty)'}</pre>}
      </div>
    </>
  )
}

export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .18s ease', flex: 'none' }}
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  )
}

export function toolGlyph(name: string): React.ReactNode {
  const n = (name || '').toLowerCase()
  if (/bash|shell|exec|run|command|terminal/.test(n)) return <><path d="M3 5l3 3-3 3" /><path d="M8.5 11H13" /></>
  if (/edit|write|update|create|patch|apply/.test(n)) return <path d="M3 11l7.5-7.5 2 2L5 13H3z" />
  if (/read|view|cat|open/.test(n)) return <path d="M4 2.5h5l3 3v8H4z" />
  if (/grep|glob|search|find|list|ls/.test(n)) return <><circle cx="6.6" cy="6.6" r="3.1" /><path d="M11 11l3 3" /></>
  if (/web|fetch|url|http|browse/.test(n)) return <><circle cx="8" cy="8" r="5" /><path d="M3 8h10M8 3c2.2 2.6 2.2 7.4 0 10" /></>
  return <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
}

export function shortSession(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id
}

export function Timestamp({ value }: { value: string }) {
  if (!value) return null
  let display = value
  try {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) {
      const hh = d.getHours().toString().padStart(2, '0')
      const mm = d.getMinutes().toString().padStart(2, '0')
      const ss = d.getSeconds().toString().padStart(2, '0')
      display = `${hh}:${mm}:${ss}`
    }
  } catch { /* fall back to raw */ }
  return (
    <span className="agentts-time" title={value}>{display}</span>
  )
}

export function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') {
    const oneLine = input.replace(/\s+/g, ' ').trim()
    return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine
  }
  if (typeof input !== 'object') return String(input)
  const obj = input as Record<string, unknown>
  const interesting = ['file_path', 'path', 'cmd', 'command', 'pattern', 'query', 'url']
  for (const key of interesting) {
    if (typeof obj[key] === 'string' && obj[key]) {
      const v = obj[key] as string
      return v.length > 80 ? v.slice(0, 77) + '…' : v
    }
  }
  try {
    const json = JSON.stringify(obj)
    return json.length > 80 ? json.slice(0, 77) + '…' : json
  } catch { return '' }
}

export function formatJson(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
