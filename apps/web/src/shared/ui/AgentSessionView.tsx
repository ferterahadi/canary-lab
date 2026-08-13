import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type { AgentSessionEvent, AgentSessionResponse, SubagentThread } from '@/shared/api/client'
import { connectAgentSessionStream } from '@/shared/api/agent-session-socket'
import { formatElapsedSeconds } from '@/shared/lib/format'
import { EventRow, SystemRow, groupSystemLines, shortSession } from './AgentSessionRows'
import { EmptyGlyph, EmptyState, type EmptyStateTone } from './EmptyState'
import { TIMELINE_CSS } from './agent-session-css'

export { Markdown, SubagentThreadRow, SystemRow, formatJson, groupSystemLines, summarizeInput, threadDuration } from './AgentSessionRows'
export type { SystemGroup } from './AgentSessionRows'

// Single agent viewer for the wizard (draft planning/generating) and the run
// detail page. Renders the agent CLI's JSONL as a chat-style timeline:
// `MessageCard` / `ThinkingCard` / `ToolCallCard` / `ToolResultCard`.
//
// Two transports:
//   - REST snapshot via `getAgentSession` and its per-subsystem siblings for the
//     initial render — gives us every event already on disk.
//   - Live WS via `connectAgentSessionStream` when `live` is set — appends
//     newly-tailed events as they arrive.
//
// The pre-existing `pollUntilFound` mode is gone; the live WS handles
// "session not yet on disk" by retrying internally on the server.

export type AgentSessionSource =
  | { kind: 'run'; runId: string; live?: boolean }
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
  /** Host-supplied copy for the "there is no session" state. A host usually
   *  knows WHY there's no transcript ("this run passed, so no repair agent was
   *  ever spawned") — far more use than the generic fallback below. */
  empty?: { title: string; body?: string; tone?: EmptyStateTone }
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

export function AgentSessionView({ source, systemRows, empty }: Props) {
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
      return api.getFlightPlanAgentSession(source.taskId)
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
                      : { kind: 'flight-plan', taskId: source.taskId },
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
  const live = source?.live === true

  if (error && !hasSystem) {
    return (
      <EmptyState
        icon={EmptyGlyph.agent}
        title="Couldn't load the session log"
        body="The agent's transcript is read from the CLI's own session file. This one couldn't be opened."
        footnote={<code style={{ fontFamily: 'var(--font-mono)' }}>{error}</code>}
      />
    )
  }
  if (loading && !hasSystem) {
    return <EmptyState icon={EmptyGlyph.waiting} title="Loading session…" />
  }
  if ((!state || (!state.sessionId && state.events.length === 0)) && !hasSystem) {
    if (source?.live) {
      return (
        <div className="relative flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-base)' }}>
          <style>{TIMELINE_CSS}</style>
          <div className="flex min-h-0 flex-1 flex-col">
            <EmptyState
              icon={EmptyGlyph.waiting}
              title="Waiting for the agent's first output"
              body="The session is starting. Thinking, tool calls, and results stream in here the moment the agent writes its first line — nothing is buffered until the end."
            />
          </div>
          <ol className="agentts-rail agentts-waitrail">
            <LiveTail label="Starting" />
          </ol>
        </div>
      )
    }
    return (
      <EmptyState
        icon={empty?.tone === 'good' ? EmptyGlyph.check : EmptyGlyph.agent}
        {...(empty?.tone ? { tone: empty.tone } : {})}
        title={empty?.title ?? 'No agent session was recorded'}
        body={empty?.body ?? 'Nothing ran here, or it ran outside Canary Lab — there is no transcript to replay.'}
      />
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
            <span className="agentts-mode" data-live={live ? 'true' : 'false'} data-testid="agent-session-mode">
              <span className="agentts-statusdot" aria-hidden="true" />
              {live ? 'Live' : 'History'}
            </span>
            <span className="agentts-agent">{state.agent}</span>
            {/* No "session" caption — a short mono id sitting beside the agent
                name is not something a user has to be told the name of. */}
            <span className="agentts-sid" title={state.sessionId}>{shortSession(state.sessionId)}</span>
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
          {live && <LiveTail {...pendingWork(state?.events ?? [])} />}
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

/** What the rail's live tip should say, read off the transcript rather than
 *  guessed. A `tool-call` with no matching `tool-result` is the one pending
 *  state the events actually prove — that tool is still running. Anything else
 *  only tells us the last block CLOSED (a thinking row lands when the thinking
 *  ends), so the label stays neutral instead of inventing a phase. */
export function pendingWork(events: AgentSessionEvent[]): { label: string; since?: string } {
  const last = events[events.length - 1]
  if (!last) return { label: 'Working' }
  const since = last.timestamp
  if (last.kind === 'tool-call') {
    const settled = events.some((e) => e.kind === 'tool-result' && e.toolId === last.toolId)
    if (!settled) return { label: `Running ${last.name}`, since }
  }
  return { label: 'Working', since }
}

/** Seconds since `iso`, re-rendered once a second. The elapsed clock is the one
 *  liveness signal that survives reduced motion (where the node's sweep and the
 *  dot wave both hold still), and it's what separates a 3-second gap from a
 *  stall — the question a user actually has when they see a pending row. */
function useElapsed(iso: string | undefined): string | null {
  const startedAt = useMemo(() => {
    if (!iso) return null
    const t = Date.parse(iso)
    return Number.isFinite(t) ? t : null
  }, [iso])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  if (startedAt === null) return null
  const ms = now - startedAt
  // A negative or absurd delta means the transcript's clock disagrees with the
  // browser's — no figure beats a wrong one.
  if (ms < 0 || ms > 86_400_000) return null
  return formatElapsedSeconds(ms / 1000)
}

function LiveTail({ label, since }: { label: string; since?: string }) {
  const elapsed = useElapsed(since)
  return (
    <li
      className="agentts-working"
      role="status"
      aria-label={elapsed ? `${label}, ${elapsed} elapsed` : label}
      data-testid="agent-session-live-tail"
    >
      <span className="agentts-worknode" aria-hidden="true" />
      <span className="agentts-worklabel">{label}</span>
      <span className="agentts-pixels" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {elapsed && <span className="agentts-worktime" data-testid="agent-session-live-elapsed">{elapsed}</span>}
    </li>
  )
}

function sourceCacheKey(source: AgentSessionSource): string {
  if (source.kind === 'run') return `run:${source.runId}:${source.live ? '1' : '0'}`
  if (source.kind === 'benchmark') return `benchmark:${source.benchmarkId}:${source.live ? '1' : '0'}`
  if (source.kind === 'portify') return `portify:${source.workflowId}:${source.live ? '1' : '0'}`
  if (source.kind === 'coverage') return `coverage:${source.jobId}:${source.live ? '1' : '0'}`
  if (source.kind === 'evaluation') return `evaluation:${source.taskId}:${source.live ? '1' : '0'}`
  if (source.kind === 'flight') return `flight:${source.flightId}:${source.stage}:${source.live ? '1' : '0'}`
  return `flight-plan:${source.taskId}:${source.live ? '1' : '0'}`
}
