import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as api from '../../../shared/api/client'
import type { AgentSessionEvent, AgentSessionResponse, SubagentThread } from '../../../shared/api/client'
import { connectAgentSessionStream } from '../api/agent-session-socket'

// Single agent viewer for the wizard (draft planning/generating) and the run
// detail page. Renders the agent CLI's JSONL as a chat-style timeline:
// `MessageCard` / `ThinkingCard` / `ToolCallCard` / `ToolResultCard`.
//
// Two transports:
//   - REST snapshot via `getAgentSession` / `getDraftAgentSession` for the
//     initial render — gives us every event already on disk.
//   - Live WS via `connectAgentSessionStream` when `live` is set — appends
//     newly-tailed events as they arrive.
//
// The pre-existing `pollUntilFound` mode is gone; the live WS handles
// "session not yet on disk" by retrying internally on the server.

export type AgentSessionSource =
  | { kind: 'run'; runId: string; live?: boolean }
  | { kind: 'draft'; draftId: string; stage: 'planning' | 'generating'; live?: boolean }
  | { kind: 'benchmark'; benchmarkId: string; live?: boolean }
  | { kind: 'portify'; workflowId: string; live?: boolean }
  | { kind: 'coverage'; jobId: string; live?: boolean }
  | { kind: 'evaluation'; taskId: string; live?: boolean }
  | { kind: 'flight'; flightId: string; stage: string; live?: boolean }
  | { kind: 'flight-plan'; taskId: string; live?: boolean }

interface Props {
  /** Optional: a stage with only conductor output (no spawned agent) passes
   *  `systemRows` alone and omits `source` — the same rail renders the system
   *  rows without fetching or tailing any session log. */
  source?: AgentSessionSource
  /** Flight activity band (R66): the conductor's tagged `[TAG]` log lines,
   *  rendered as distinct *system* rows at the head (`pre`) and tail (`post`)
   *  of the same rail, so the conductor's system output and the agent's own
   *  timeline read as one consolidated block. Other hosts omit it. When a
   *  stage has system rows but no agent session, the block still renders them
   *  instead of the empty "no session log" state. */
  systemRows?: { pre: string[]; post: string[] }
}

const NO_SYSTEM_ROWS = { pre: [] as string[], post: [] as string[] }

interface ViewState {
  agent: 'claude' | 'codex' | null
  sessionId: string
  model?: string
  effort?: string
  events: AgentSessionEvent[]
  /** Subagent threads keyed by the parent tool call they hang under, so a
   *  `tool-call` row can find its children by `toolId` in O(1). A parent can
   *  spawn several in one turn, hence an array per key. */
  subagents: Map<string, SubagentThread[]>
}

/** Merge one streamed subagent event into the by-parent map, keyed by the
 *  event's index within its own thread. Out-of-order and duplicate arrivals
 *  are both idempotent — the same index always lands in the same slot — which
 *  is what lets the WS replay and the REST snapshot converge. */
export function mergeSubagentEvent(
  prev: Map<string, SubagentThread[]>,
  update: { thread: Omit<SubagentThread, 'events'>; event: AgentSessionEvent; index: number },
): Map<string, SubagentThread[]> {
  const next = new Map(prev)
  const siblings = [...(next.get(update.thread.parentToolId) ?? [])]
  const at = siblings.findIndex((t) => t.agentId === update.thread.agentId)
  const thread = at >= 0 ? { ...siblings[at], events: [...siblings[at].events] } : { ...update.thread, events: [] }
  if (thread.events[update.index] === undefined) {
    thread.events[update.index] = update.event
  }
  if (at >= 0) siblings[at] = thread
  else siblings.push(thread)
  next.set(update.thread.parentToolId, siblings)
  return next
}

/** Index a snapshot's flat thread list by parent tool id. */
export function indexSubagents(threads: SubagentThread[] | undefined): Map<string, SubagentThread[]> {
  const map = new Map<string, SubagentThread[]>()
  for (const t of threads ?? []) {
    map.set(t.parentToolId, [...(map.get(t.parentToolId) ?? []), t])
  }
  return map
}

export function AgentSessionView({ source, systemRows }: Props) {
  const [state, setState] = useState<ViewState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const followingLatestRef = useRef(true)
  const [showJumpLatest, setShowJumpLatest] = useState(false)
  // Stable key for the effect dependencies — destructured rather than the
  // whole object so a new prop reference each render doesn't restart the WS.
  const sourceKey = useMemo(() => (source ? sourceCacheKey(source) : null), [source])

  useEffect(() => {
    let cancelled = false
    let conn: { close(): void } | null = null
    setError(null)
    setState(null)
    // No agent session for this stage — the block is system rows only.
    if (!source) { setLoading(false); return }
    setLoading(true)

    const applySnapshot = (snapshot: AgentSessionResponse | null): void => {
      if (cancelled) return
      if (!snapshot) {
        // No log yet on disk. Keep waiting if live; otherwise show empty state.
        setState({ agent: null, sessionId: '', events: [], subagents: new Map() })
        return
      }
      setState({
        agent: snapshot.agent,
        sessionId: snapshot.sessionId,
        model: snapshot.model,
        effort: snapshot.effort,
        events: snapshot.events,
        subagents: indexSubagents(snapshot.subagents),
      })
    }

    const fetchSnapshot = async (): Promise<AgentSessionResponse | null> => {
      if (source.kind === 'run') return api.getAgentSession(source.runId)
      if (source.kind === 'benchmark') return api.getBenchmarkAgentSession(source.benchmarkId)
      if (source.kind === 'portify') return api.getPortifyAgentSession(source.workflowId)
      if (source.kind === 'coverage') return api.getCoverageAgentSession(source.jobId)
      if (source.kind === 'evaluation') return api.getEvaluationAgentSession(source.taskId)
      if (source.kind === 'flight') return api.getFlightAgentSession(source.flightId, source.stage)
      if (source.kind === 'flight-plan') return api.getFlightPlanAgentSession(source.taskId)
      return api.getDraftAgentSession(source.draftId, source.stage)
    }

    fetchSnapshot()
      .then((snapshot) => {
        applySnapshot(snapshot)
        if (cancelled) return
        setLoading(false)
        if (!source.live) return
        // Open the live WS. The server replays events from the start of the
        // file, so dedupe by index relative to the snapshot length.
        let snapshotLen = snapshot?.events.length ?? 0
        let seenFromWs = 0
        conn = connectAgentSessionStream({
          source: source.kind === 'run'
            ? { kind: 'run', runId: source.runId }
            : source.kind === 'benchmark'
              ? { kind: 'benchmark', benchmarkId: source.benchmarkId }
              : source.kind === 'portify'
                ? { kind: 'portify', workflowId: source.workflowId }
                : source.kind === 'coverage'
                  ? { kind: 'coverage', jobId: source.jobId }
                  : source.kind === 'evaluation'
                    ? { kind: 'evaluation', taskId: source.taskId }
                    : source.kind === 'flight'
                      ? { kind: 'flight', flightId: source.flightId, stage: source.stage }
                      : source.kind === 'flight-plan'
                        ? { kind: 'flight-plan', taskId: source.taskId }
                        : { kind: 'draft', draftId: source.draftId, stage: source.stage },
          onSession: (session) => {
            if (cancelled) return
            setState((prev) => prev
              ? { ...prev, agent: session.agent, sessionId: session.sessionId, model: session.model, effort: session.effort }
              : { agent: session.agent, sessionId: session.sessionId, model: session.model, effort: session.effort, events: [], subagents: new Map() })
          },
          onSubagentEvent: (update) => {
            if (cancelled) return
            setState((prev) => prev
              ? { ...prev, subagents: mergeSubagentEvent(prev.subagents, update) }
              : { agent: null, sessionId: '', events: [], subagents: mergeSubagentEvent(new Map(), update) })
          },
          onEvent: (event) => {
            if (cancelled) return
            // The first `snapshotLen` events the WS sends are replay of what
            // we already have. Drop them; append the rest.
            seenFromWs += 1
            if (seenFromWs <= snapshotLen) return
            setState((prev) => {
              if (!prev) return { agent: null, sessionId: '', events: [event], subagents: new Map() }
              return { ...prev, events: [...prev.events, event] }
            })
          },
          onError: (err) => {
            if (cancelled) return
            // Don't surface every transient ws error as a hard failure — the
            // server reports things like "session-log-missing" while the
            // agent is still booting.
            if (err === 'session-log-missing' || err === 'no-session-ref') return
            setError(err)
          },
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      cancelled = true
      if (conn) conn.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])

  // Auto-scroll-to-bottom while the user is following the latest. Re-evaluate
  // after every event append.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (followingLatestRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [state?.events.length])

  const onScroll = (): void => {
    const el = scrollerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
    const atBottom = distanceFromBottom <= 16
    followingLatestRef.current = atBottom
    setShowJumpLatest(!atBottom)
  }

  const jumpLatest = (): void => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    followingLatestRef.current = true
    setShowJumpLatest(false)
  }

  // System rows keep the consolidated block alive even before (or without) an
  // agent session — a stage with only conductor output still renders its rail.
  const sys = systemRows ?? NO_SYSTEM_ROWS
  const hasSystem = sys.pre.length > 0 || sys.post.length > 0

  if (error && !hasSystem) {
    return (
      <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
        Failed to load session log: {error}
      </div>
    )
  }
  if (loading && !hasSystem) {
    return (
      <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading session…
      </div>
    )
  }
  if ((!state || (!state.sessionId && state.events.length === 0)) && !hasSystem) {
    return (
      <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
        {source?.live ? 'Waiting for agent output…' : 'No structured session log found.'}
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-base)' }}>
      <style>{TIMELINE_CSS}</style>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="h-full min-h-0 flex-1 overflow-y-auto"
      >
        {state?.agent && state.sessionId && (
          <div className="agentts-head">
            <span className="agentts-statusdot" aria-hidden="true" />
            <span className="agentts-agent">{state.agent}</span>
            <span className="agentts-sep">/ session</span>
            <span className="agentts-sid">{shortSession(state.sessionId)}</span>
            {state.model && (
              <>
                <span className="agentts-dot" aria-hidden="true">·</span>
                <span className="agentts-model">{state.model}</span>
              </>
            )}
            {state.effort && (
              <>
                <span className="agentts-dot" aria-hidden="true">·</span>
                <span className="agentts-model">{state.effort}</span>
              </>
            )}
            <span style={{ flex: '1 1 auto' }} />
            <span className="agentts-count">{state.events.length} event{state.events.length === 1 ? '' : 's'}</span>
          </div>
        )}
        <ol className="agentts-rail">
          {groupSystemLines(sys.pre).map((group, idx) => (
            <SystemRow key={`sys-pre-${idx}`} group={group} />
          ))}
          {(state?.events ?? []).map((event: AgentSessionEvent, idx: number) => (
            <EventRow key={idx} event={event} subagents={state?.subagents} />
          ))}
          {groupSystemLines(sys.post).map((group, idx) => (
            <SystemRow key={`sys-post-${idx}`} group={group} />
          ))}
        </ol>
      </div>
      {showJumpLatest && (
        <button
          type="button"
          onClick={jumpLatest}
          aria-label="Jump to latest"
          title="Jump to latest"
          className="absolute bottom-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-full opacity-85 transition-all duration-150 hover:opacity-100 hover:[box-shadow:var(--shadow-popover)]"
          style={{
            color: 'var(--accent)',
            background: 'color-mix(in srgb, var(--bg-elevated) 94%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent) 32%, var(--border-default))',
            boxShadow: 'var(--shadow-panel)',
            backdropFilter: 'blur(6px)',
          }}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 5l4 4 4-4" />
            <path d="M4 13.25h8" />
          </svg>
        </button>
      )}
    </div>
  )
}

function sourceCacheKey(source: AgentSessionSource): string {
  if (source.kind === 'run') return `run:${source.runId}:${source.live ? '1' : '0'}`
  if (source.kind === 'benchmark') return `benchmark:${source.benchmarkId}:${source.live ? '1' : '0'}`
  if (source.kind === 'portify') return `portify:${source.workflowId}:${source.live ? '1' : '0'}`
  if (source.kind === 'coverage') return `coverage:${source.jobId}:${source.live ? '1' : '0'}`
  if (source.kind === 'evaluation') return `evaluation:${source.taskId}:${source.live ? '1' : '0'}`
  if (source.kind === 'flight') return `flight:${source.flightId}:${source.stage}:${source.live ? '1' : '0'}`
  if (source.kind === 'flight-plan') return `flight-plan:${source.taskId}:${source.live ? '1' : '0'}`
  return `draft:${source.draftId}:${source.stage}:${source.live ? '1' : '0'}`
}

// ─── Timeline rows ───────────────────────────────────────────────────────────
// Each event is a node on a single vertical rail: a typed marker (role/tool
// glyph) + its content. Tool calls/results collapse to one mono line and
// disclose their full payload; prose reads as a clean transcript.

function EventRow({ event, subagents }: { event: AgentSessionEvent; subagents?: Map<string, SubagentThread[]> }) {
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
const SYSTEM_GROUP_SPLIT_MS = 60_000

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

const NODE_ACCENT: Record<AgentSessionEvent['kind'], string> = {
  'user-message': 'var(--boot)',
  'assistant-message': 'var(--assistant)',
  'assistant-thinking': 'var(--text-muted)',
  'tool-call': 'var(--warning)',
  'tool-result': 'var(--text-muted)',
}

function NodeMarker({ event }: { event: AgentSessionEvent }) {
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

function NodeGlyph({ event }: { event: AgentSessionEvent }) {
  if (event.kind === 'tool-call') return <NodeSvg>{toolGlyph(event.name)}</NodeSvg>
  if (event.kind === 'tool-result') {
    return <NodeSvg>{event.isError ? <path d="M5 5l6 6M11 5l-6 6" /> : <path d="M3.5 8.5l3 3 6-6.5" />}</NodeSvg>
  }
  if (event.kind === 'user-message') return <NodeSvg><path d="M6 4l4 4-4 4" /></NodeSvg>
  return null // assistant + thinking → the filled/hollow dot is enough
}

function NodeSvg({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

function EventBody({ event, subagents }: { event: AgentSessionEvent; subagents?: Map<string, SubagentThread[]> }) {
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
function ApiErrorBody({ text, timestamp }: { text: string; timestamp: string }) {
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

function firstLineOf(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

function RowHead({ label, timestamp }: { label: string; timestamp: string }) {
  return (
    <div className="agentts-rowhead">
      <span className="agentts-label">{label}</span>
      <Timestamp value={timestamp} />
    </div>
  )
}

function ProseBody({ label, text, timestamp }: { label: string; text: string; timestamp: string }) {
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

const CLAMP_3: React.CSSProperties = {
  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
}

function PromptBody({ text, timestamp }: { text: string; timestamp: string }) {
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

function ThinkingBody({ text, timestamp }: { text: string; timestamp: string }) {
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

function ToolCallBody({ name, input, timestamp, toolId, threads }: {
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

function ToolResultBody({ output, isError, timestamp, toolId }: { output: string; isError?: boolean; timestamp: string; toolId: string }) {
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

function Chevron({ open, className }: { open: boolean; className?: string }) {
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

function toolGlyph(name: string): React.ReactNode {
  const n = (name || '').toLowerCase()
  if (/bash|shell|exec|run|command|terminal/.test(n)) return <><path d="M3 5l3 3-3 3" /><path d="M8.5 11H13" /></>
  if (/edit|write|update|create|patch|apply/.test(n)) return <path d="M3 11l7.5-7.5 2 2L5 13H3z" />
  if (/read|view|cat|open/.test(n)) return <path d="M4 2.5h5l3 3v8H4z" />
  if (/grep|glob|search|find|list|ls/.test(n)) return <><circle cx="6.6" cy="6.6" r="3.1" /><path d="M11 11l3 3" /></>
  if (/web|fetch|url|http|browse/.test(n)) return <><circle cx="8" cy="8" r="5" /><path d="M3 8h10M8 3c2.2 2.6 2.2 7.4 0 10" /></>
  return <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
}

function shortSession(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id
}

const TIMELINE_CSS = `
.agentts-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:9px 16px;border-bottom:1px solid var(--border-default);background:color-mix(in srgb,var(--bg-base) 90%,transparent);backdrop-filter:blur(8px);font-size:11px}
.agentts-statusdot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 9px color-mix(in srgb,var(--accent) 65%,transparent);flex:none}
.agentts-agent{font-weight:600;color:var(--text-primary);text-transform:uppercase;letter-spacing:.07em;font-size:10.5px}
.agentts-sep{color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;font-size:9.5px}
.agentts-sid{font-family:var(--font-mono);color:var(--text-secondary);font-size:10.5px}
.agentts-dot{color:var(--text-muted);font-size:10.5px}
.agentts-model{font-family:var(--font-mono);color:var(--text-secondary);font-size:10.5px}
.agentts-count{color:var(--text-muted);font-size:10px;font-variant-numeric:tabular-nums}
.agentts-rail{margin:0;padding:14px 18px 18px;list-style:none}
.agentts-row{position:relative;padding:0 0 15px 28px;animation:agentts-in .26s cubic-bezier(.22,1,.36,1) both}
.agentts-row:last-child{padding-bottom:2px}
.agentts-row::before{content:'';position:absolute;left:7px;top:17px;bottom:-1px;width:1.5px;background:linear-gradient(180deg,var(--border-default),color-mix(in srgb,var(--border-default) 25%,transparent));border-radius:2px}
.agentts-row:last-child::before{display:none}
.agentts-node{position:absolute;left:0;top:2px;width:15px;height:15px;border-radius:50%;border:1.5px solid var(--border-default);display:grid;place-items:center;background:var(--bg-base);z-index:1}
.agentts-sysrow{position:relative;margin:0;padding:0 0 13px 28px;list-style:none;animation:agentts-in .26s cubic-bezier(.22,1,.36,1) both}
.agentts-sysrow:last-child{padding-bottom:2px}
.agentts-sysrow::before{content:'';position:absolute;left:7px;top:17px;bottom:-1px;width:1.5px;background:linear-gradient(180deg,var(--border-default),color-mix(in srgb,var(--border-default) 25%,transparent));border-radius:2px}
.agentts-sysrow:last-child::before{display:none}
.agentts-sysnode{position:absolute;left:0;top:2px;width:15px;height:15px;border-radius:4px;border:1.5px solid var(--border-default);display:grid;place-items:center;background:var(--bg-base);color:var(--text-muted);z-index:1}
.agentts-sysnode svg{width:9px;height:9px}
.agentts-sysbody{display:flex;flex-direction:column;gap:2px;min-width:0}
.agentts-sysline{display:flex;align-items:baseline;min-width:0}
.agentts-systag{font-family:var(--font-mono)}
.agentts-systext{font-family:var(--font-mono);font-size:13px;line-height:1.62;color:var(--text-secondary);word-break:break-word;white-space:pre-wrap;min-width:0}
.agentts-sysrepeat{margin-left:6px;color:var(--text-muted)}
.agentts-node svg{width:8.5px;height:8.5px}
.agentts-rowhead{display:flex;align-items:center;gap:8px;min-height:15px}
.agentts-label{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);font-weight:600}
.agentts-prose{color:var(--text-primary);font-size:13px;line-height:1.62;white-space:pre-wrap;word-break:break-word;margin-top:3px}
.agentts-morebtn{margin-top:4px;background:none;border:none;cursor:pointer;color:var(--accent);font-size:11px;padding:0;font-weight:500}
.agentts-tool{margin-top:4px;border:1px solid var(--border-default);border-radius:var(--radius-md);background:color-mix(in srgb,var(--bg-elevated) 55%,transparent);overflow:hidden;transition:border-color .15s ease,background .15s ease}
.agentts-tool:hover{background:color-mix(in srgb,var(--bg-elevated) 85%,transparent)}
.agentts-toolbtn{display:flex;width:100%;align-items:center;gap:9px;padding:7px 11px;background:none;border:none;cursor:pointer;text-align:left;min-width:0}
.agentts-toolname{font-family:var(--font-mono);font-weight:600;font-size:12px;color:var(--text-primary);flex:none}
.agentts-tooltarget{font-family:var(--font-mono);font-size:11.5px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.agentts-chev{margin-left:auto;color:var(--text-muted)}
.agentts-pre{margin:0;border-top:1px solid var(--border-default);padding:9px 12px;font-family:var(--font-mono);font-size:11px;line-height:1.55;color:var(--text-secondary);background:var(--bg-base);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto}
.agentts-sub{border-top:1px solid var(--border-default)}
.agentts-subbtn{display:flex;width:100%;align-items:center;gap:8px;padding:6px 11px;background:none;border:none;cursor:pointer;text-align:left;min-width:0}
.agentts-subbtn:hover{background:color-mix(in srgb,var(--bg-elevated) 70%,transparent)}
.agentts-sublive{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px color-mix(in srgb,var(--accent) 60%,transparent);flex:none}
.agentts-subtype{flex:none;font-family:var(--font-mono);font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 35%,var(--border-default));border-radius:4px;padding:1px 5px}
.agentts-submeta{font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.agentts-nest{margin:0 0 0 15px;padding:8px 12px 4px 12px;list-style:none;border-left:2px solid var(--border-default);background:var(--bg-base)}
.agentts-nestrow{padding-bottom:11px}
.agentts-nestrow::before{left:5px;top:14px}
.agentts-nestrow .agentts-node{width:11px;height:11px;top:3px}
.agentts-nestrow .agentts-node svg{width:6.5px;height:6.5px}
.agentts-nestrow .agentts-prose{font-size:12px}
.agentts-think{margin-top:1px}
.agentts-thinkbtn{display:inline-flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.07em;font-weight:600;padding:0}
.agentts-thinkbody{margin-top:6px;color:var(--text-muted);font-size:12px;line-height:1.55;font-style:italic;white-space:pre-wrap;border-left:2px solid var(--border-default);padding-left:11px}
.agentts-md{white-space:normal}
.agentts-md>*:first-child{margin-top:0}
.agentts-md>*:last-child{margin-bottom:0}
.agentts-md p{margin:0 0 8px}
.agentts-md h1,.agentts-md h2,.agentts-md h3,.agentts-md h4,.agentts-md h5,.agentts-md h6{margin:14px 0 6px;font-weight:650;line-height:1.3;color:var(--text-primary)}
.agentts-md h1{font-size:15px}
.agentts-md h2{font-size:14px}
.agentts-md h3{font-size:13px}
.agentts-md h4,.agentts-md h5,.agentts-md h6{font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-secondary)}
.agentts-md ul,.agentts-md ol{margin:0 0 8px;padding-left:20px}
.agentts-md li{margin:2px 0}
.agentts-md li>ul,.agentts-md li>ol{margin:2px 0}
.agentts-md a{color:var(--accent);text-decoration:none}
.agentts-md a:hover{text-decoration:underline}
.agentts-md code{font-family:var(--font-mono);font-size:.88em;background:color-mix(in srgb,var(--bg-elevated) 70%,transparent);border:1px solid var(--border-default);border-radius:var(--radius-sm,4px);padding:1px 4px}
.agentts-md pre{margin:0 0 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);background:var(--bg-base);padding:9px 12px;overflow:auto;max-height:300px}
.agentts-md pre code{background:none;border:none;padding:0;font-size:11px;line-height:1.55}
.agentts-md blockquote{margin:0 0 8px;border-left:2px solid var(--border-default);padding-left:11px;color:var(--text-secondary)}
.agentts-md hr{border:none;border-top:1px solid var(--border-default);margin:12px 0}
.agentts-md table{border-collapse:collapse;margin:0 0 8px;font-size:12px;display:block;overflow-x:auto;max-width:100%}
.agentts-md th,.agentts-md td{border:1px solid var(--border-default);padding:5px 9px;text-align:left;vertical-align:top}
.agentts-md th{background:color-mix(in srgb,var(--bg-elevated) 60%,transparent);font-weight:600;color:var(--text-primary)}
.agentts-md img{max-width:100%}
@keyframes agentts-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.agentts-row,.agentts-sysrow{animation:none}}
`

function Timestamp({ value }: { value: string }) {
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
    <span title={value} style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{display}</span>
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
