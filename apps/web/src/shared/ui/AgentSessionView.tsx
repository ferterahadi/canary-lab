import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as api from '@/shared/api/client'
import { isAgentSessionAbsence } from '@/shared/api/client'
import type { AgentSessionAbsence, AgentSessionEvent, AgentSessionResponse, SubagentThread } from '@/shared/api/client'
import { connectAgentSessionStream } from '@/shared/api/agent-session-socket'
import { formatElapsedSeconds } from '@/shared/lib/format'
import { clientKindToDesktopAgent, clientLabel, type ExternalClientKind } from './external-client-branding'
import { useOpenAgentApp } from './ExternalAgentCard'
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

export interface ExternalSessionActivity {
  clientKind: ExternalClientKind
  status: 'running' | 'ready' | 'done' | 'failed' | 'aborted'
  message: string
  startedAt?: string
  endedAt?: string
  conversationName?: string
  sessionUrl?: string
}

/** One independently fetched/tail-able session in a stage's ordered Activity
 *  history. `label` names why this session exists (for example, pass 2 mapping)
 *  while the session header keeps the actual agent/model/id provenance.
 *  `startedAt` positions compact conductor rows around the sessions; agent
 *  events themselves still come only from the CLI JSONL source. */
export interface AgentSessionSegmentSource {
  source: AgentSessionSource
  label?: string
  startedAt?: string
}

interface Props {
  /** Optional: a stage with only conductor output (no spawned agent) passes
   *  `systemRows` alone and omits `source` — the same rail renders the system
   *  rows without fetching or tailing any session log. */
  source?: AgentSessionSource
  /** Ordered stage history. Each source retains its own header and event count;
   *  only the entry marked live opens a WebSocket tail. When present this takes
   *  precedence over the legacy single `source`. */
  sessionSources?: AgentSessionSegmentSource[]
  /** Flight activity band (R66): the conductor's tagged `[TAG]` log lines,
   *  rendered as distinct *system* rows at the head (`pre`) and tail (`post`)
   *  of the same rail, so the conductor's system output and the agent's own
   *  timeline read as one consolidated block. Other hosts omit it. When a
   *  stage has system rows but no agent session, the block still renders them
   *  instead of the empty "no session log" state. */
  systemRows?: { pre: string[]; between?: string[][]; post: string[] }
  /** Tasks whose transcripts live in the user's own Claude/Codex window. Each
   *  occupies one real chronological row on this rail instead of a second
   *  branded card; the dedicated task screens own their full monitors. They
   *  render at the TAIL of the rail: the hand-off is the newest thing that
   *  happened, so it reads after the conductor lines that announced it — at the
   *  head it claimed the work started before the log that led to it. */
  externalSessions?: ExternalSessionActivity[]
  /** Host-supplied copy for the "there is no session" state. A host usually
   *  knows WHY there's no transcript ("this run passed, so no repair agent was
   *  ever spawned") — far more use than the generic fallback below. */
  empty?: { title: string; body?: string; tone?: EmptyStateTone }
}

interface SingleSessionProps extends Omit<Props, 'sessionSources'> {
  /** Render inside the history view's one shared scroller. */
  embedded?: boolean
  segmentLabel?: string
  onTimelineChange?: () => void
  /** A stack states its agent + model ONCE (see `AgentSessionHistoryView`).
   *  Each segment reports the pair it actually loaded under `segmentKey`, so a
   *  segment that diverges from the stack's first one can still show its own. */
  segmentKey?: string
  showProvenance?: boolean
  onProvenance?: (key: string, fingerprint: string) => void
}

const NO_SYSTEM_ROWS = { pre: [] as string[], between: [] as string[][], post: [] as string[] }

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

/** Back-off for the history (non-live) snapshot when nothing is on disk yet.
 *  Three tries over ~9.5s covers a CLI flush racing the terminal status write;
 *  past that, the log really is absent. */
const HISTORY_RETRY_DELAYS_MS = [1500, 3000, 5000]

export function AgentSessionView({ sessionSources, ...props }: Props) {
  if (sessionSources && sessionSources.length > 0) {
    return <AgentSessionHistoryView sessionSources={sessionSources} {...props} />
  }
  // Session identity, not live/history mode, owns component state. A source
  // swap gets a clean viewer; the same session becoming historical keeps its
  // loaded transcript while the non-live snapshot refreshes.
  const identity = props.source ? sourceIdentityKey(props.source) : 'system-only'
  return <SingleAgentSessionView key={identity} {...props} />
}

function AgentSessionHistoryView({
  sessionSources,
  systemRows,
  externalSessions = [],
  empty,
}: Omit<Props, 'source'> & { sessionSources: AgentSessionSegmentSource[] }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const followingLatestRef = useRef(true)
  const [showJumpLatest, setShowJumpLatest] = useState(false)
  const [timelineRevision, setTimelineRevision] = useState(0)
  const onTimelineChange = useCallback(() => setTimelineRevision((revision) => revision + 1), [])
  const sessionKey = sessionSources.map(({ source }) => sourceCacheKey(source)).join('|')
  const sys = systemRows ?? NO_SYSTEM_ROWS
  const betweenRowCount = sys.between?.reduce((count, rows) => count + rows.length, 0) ?? 0

  // Every pass of a stage is spawned by the same conductor with the same agent
  // and model, so repeating that pair on each segment header states one fact N
  // times — the noisiest thing in a three-segment stack. The first header states
  // it; a later one restates it only when it genuinely differs. Segments report
  // what they loaded rather than the parent guessing, so a divergent model can
  // never be silently hidden.
  const [provenance, setProvenance] = useState<Record<string, string>>({})
  const reportProvenance = useCallback((key: string, fingerprint: string) => {
    setProvenance((prev) => (prev[key] === fingerprint ? prev : { ...prev, [key]: fingerprint }))
  }, [])
  const baseline = provenance[sourceIdentityKey(sessionSources[0].source)]

  useEffect(() => {
    const el = scrollerRef.current
    if (el && followingLatestRef.current) el.scrollTop = el.scrollHeight
  }, [betweenRowCount, sessionKey, timelineRevision, externalSessions.length, sys.pre.length, sys.post.length])

  const onScroll = (): void => {
    const el = scrollerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) <= 16
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

  return (
    <div className="relative flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-base)' }}>
      <style>{TIMELINE_CSS}</style>
      <div ref={scrollerRef} onScroll={onScroll} className="h-full min-h-0 flex-1 overflow-y-auto">
        {sys.pre.length > 0 && (
          <ol className="agentts-rail">
            {groupSystemLines(sys.pre).map((group, index) => <SystemRow key={`sys-pre-${index}`} group={group} />)}
          </ol>
        )}
        {sessionSources.map(({ source, label }, sessionIndex) => {
          const segmentKey = sourceIdentityKey(source)
          const reported = provenance[segmentKey]
          // Unknown stays hidden rather than shown-then-hidden: a segment still
          // loading must not flash a model id that is about to be deduped away.
          const showProvenance = sessionIndex === 0
            || (baseline !== undefined && reported !== undefined && reported !== baseline)
          return (
          <Fragment key={segmentKey}>
            <SingleAgentSessionView
              source={source}
              segmentLabel={label}
              embedded
              empty={empty}
              onTimelineChange={onTimelineChange}
              segmentKey={segmentKey}
              showProvenance={showProvenance}
              onProvenance={reportProvenance}
            />
            {(sys.between?.[sessionIndex]?.length ?? 0) > 0 && (
              <ol className="agentts-rail">
                {groupSystemLines(sys.between?.[sessionIndex] ?? []).map((group, index) => (
                  <SystemRow key={`sys-between-${sessionIndex}-${index}`} group={group} />
                ))}
              </ol>
            )}
          </Fragment>
          )
        })}
        {(sys.post.length > 0 || externalSessions.length > 0) && (
          <ol className="agentts-rail">
            {groupSystemLines(sys.post).map((group, index) => <SystemRow key={`sys-post-${index}`} group={group} />)}
            {externalSessions.map((session, index) => (
              <ExternalSessionRow
                key={`${session.startedAt ?? 'unknown'}:${session.endedAt ?? 'live'}:${session.clientKind}:${index}`}
                session={session}
              />
            ))}
          </ol>
        )}
      </div>
      {showJumpLatest && <JumpLatestButton onClick={jumpLatest} />}
    </div>
  )
}

function SingleAgentSessionView({ source, systemRows, externalSessions = [], empty, embedded = false, segmentLabel, onTimelineChange, segmentKey, showProvenance = true, onProvenance }: SingleSessionProps) {
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
    // No agent session for this stage — the block is system rows only.
    if (!source) { setLoading(false); return }
    setLoading(true)

    const applySnapshot = (snapshot: AgentSessionResponse | AgentSessionAbsence | null): void => {
      if (cancelled) return
      if (!snapshot || isAgentSessionAbsence(snapshot)) {
        // No log yet on disk, or a definitive "never recorded". Keep waiting if
        // live; otherwise show the empty state.
        setState((previous) => previous && (previous.sessionId || previous.events.length > 0)
          ? previous
          : { agent: null, sessionId: '', events: [], subagents: new Map() })
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

    const fetchSnapshot = async (): Promise<AgentSessionResponse | AgentSessionAbsence | null> => {
      if (source.kind === 'run') return api.getAgentSession(source.runId)
      if (source.kind === 'benchmark') return api.getBenchmarkAgentSession(source.benchmarkId)
      if (source.kind === 'portify') return api.getPortifyAgentSession(source.workflowId)
      if (source.kind === 'coverage') return api.getCoverageAgentSession(source.jobId)
      if (source.kind === 'evaluation') return api.getEvaluationAgentSession(source.taskId)
      if (source.kind === 'flight') return api.getFlightAgentSession(source.flightId, source.stage)
      return api.getFlightPlanAgentSession(source.taskId)
    }

    // A run whose status has just gone terminal can beat the agent CLI's final
    // flush of its session log to disk. With `live` false there is no WS to
    // tail, so that one-shot read is the only chance the pane gets — and a null
    // there froze it on "no transcript" permanently, while the file appeared
    // moments later. Retry a few times before believing the absence. Bounded on
    // purpose: the `pollUntilFound` mode this replaces waited indefinitely and
    // turned a genuinely absent log into a permanent spinner.
    //
    // Only retry absences that can actually resolve. `session-log-missing`
    // (a ref exists, the CLI's file hasn't landed) is that race for every
    // source; a run's `no-session-ref` is too, because the ref file is written
    // by heal-loop cleanup and can trail the terminal status. Every other
    // absence — `no-session`, `run-not-found`, `task-not-found` — is the server
    // saying "nothing was ever recorded", and retrying it held the pane on
    // "Loading session…" for the full back-off on every agentless stage open
    // (the shipped demo's derived flights hit this on every stage).
    const absenceCanResolve = (a: AgentSessionAbsence): boolean =>
      a.reason === 'session-log-missing' || (source.kind === 'run' && a.reason === 'no-session-ref')
    const fetchHistorySnapshot = async (): Promise<AgentSessionResponse | AgentSessionAbsence | null> => {
      let snapshot = await fetchSnapshot()
      for (const delayMs of HISTORY_RETRY_DELAYS_MS) {
        if (cancelled) return snapshot
        if (isAgentSessionAbsence(snapshot)) {
          if (!absenceCanResolve(snapshot)) return snapshot
        } else if (snapshot && snapshot.events.length > 0) {
          return snapshot
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (cancelled) return snapshot
        snapshot = await fetchSnapshot()
      }
      return snapshot
    }

    ;(source.live ? fetchSnapshot() : fetchHistorySnapshot())
      .then((snapshot) => {
        applySnapshot(snapshot)
        if (cancelled) return
        setLoading(false)
        if (!source.live) return
        // Open the live WS. The server replays events from the start of the
        // file, so dedupe by index relative to the snapshot length.
        let snapshotLen = snapshot && !isAgentSessionAbsence(snapshot) ? snapshot.events.length : 0
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
    if (embedded) return
    const el = scrollerRef.current
    if (!el) return
    if (followingLatestRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [embedded, state?.events.length])

  useEffect(() => {
    onTimelineChange?.()
  }, [error, loading, onTimelineChange, state?.events.length, state?.sessionId])

  // Report the agent + model this segment actually loaded, so the stack that
  // owns several segments can state the pair once and still surface a segment
  // that diverges from it.
  const provenanceFingerprint = state?.agent
    ? `${state.agent}|${state.model ?? ''}|${state.effort ?? ''}`
    : null
  useEffect(() => {
    if (segmentKey && provenanceFingerprint) onProvenance?.(segmentKey, provenanceFingerprint)
  }, [onProvenance, provenanceFingerprint, segmentKey])

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
  const hasSystem = sys.pre.length > 0 || sys.post.length > 0 || externalSessions.length > 0
  const live = source?.live === true
  const embeddedState = (content: ReactNode): ReactNode => embedded
    ? (
        <section className="agentts-history-segment" data-testid="agent-session-segment" data-session-label={segmentLabel}>
          {content}
        </section>
      )
    : content

  if (error && !state && !hasSystem) {
    return embeddedState(
      <EmptyState
        icon={EmptyGlyph.agent}
        title="Couldn't load the session log"
        body="The agent's transcript is read from the CLI's own session file. This one couldn't be opened."
        footnote={<code style={{ fontFamily: 'var(--font-mono)' }}>{error}</code>}
      />
    )
  }
  if (loading && !state && !hasSystem) {
    return embeddedState(<EmptyState icon={EmptyGlyph.waiting} title="Loading session…" />)
  }
  if ((!state || (!state.sessionId && state.events.length === 0)) && !hasSystem) {
    if (source?.live) {
      const waiting = (
        <div className="relative flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-base)' }}>
          {!embedded && <style>{TIMELINE_CSS}</style>}
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
      return embeddedState(waiting)
    }
    return embeddedState(
      <EmptyState
        icon={empty?.tone === 'good' ? EmptyGlyph.check : EmptyGlyph.agent}
        {...(empty?.tone ? { tone: empty.tone } : {})}
        title={empty?.title ?? 'No agent session was recorded'}
        body={empty?.body ?? 'Nothing ran here, or it ran outside Canary Lab — there is no transcript to replay.'}
      />
    )
  }

  const timeline = (
    <>
      {state?.agent && state.sessionId && (
        <SessionHeader state={state} live={live} label={segmentLabel} embedded={embedded} showProvenance={showProvenance} />
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
        {externalSessions.map((session, index) => (
          <ExternalSessionRow
            key={`${session.startedAt ?? 'unknown'}:${session.endedAt ?? 'live'}:${session.clientKind}:${index}`}
            session={session}
          />
        ))}
        {live && <LiveTail {...pendingWork(state?.events ?? [])} />}
      </ol>
    </>
  )

  if (embedded) return embeddedState(timeline)

  return (
    <div className="relative flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-base)' }}>
      <style>{TIMELINE_CSS}</style>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="h-full min-h-0 flex-1 overflow-y-auto"
      >
        {timeline}
      </div>
      {showJumpLatest && <JumpLatestButton onClick={jumpLatest} />}
    </div>
  )
}

/** A model id already names its vendor (`claude-opus-5`, `gpt-5-codex`), so
 *  printing the agent beside it says the same word twice. Name the agent only
 *  when the model can't stand in for it — or when there is no model to read. */
function agentNeedsNaming(agent: string, model?: string): boolean {
  if (!model) return true
  return !model.toLowerCase().includes(agent.toLowerCase())
}

function SessionHeader({ state, live, label, embedded, showProvenance }: {
  state: ViewState
  live: boolean
  label?: string
  embedded: boolean
  /** False for a later segment in a stack that already stated this agent and
   *  model on its first header — see `AgentSessionHistoryView`. */
  showProvenance: boolean
}) {
  return (
    <div className="agentts-head" data-sticky={embedded ? 'false' : 'true'} data-testid="agent-session-header">
      {label && <span className="agentts-session-label" data-testid="agent-session-label">{label}</span>}
      <span className="agentts-mode" data-live={live ? 'true' : 'false'} data-testid="agent-session-mode">
        {live
          ? <><span className="agentts-statusdot" aria-hidden="true" />Live</>
          : 'History'}
      </span>
      <span className="agentts-headrule" aria-hidden="true" />
      <span className="agentts-provenance">
        {showProvenance && state.agent && agentNeedsNaming(state.agent, state.model) && (
          <span className="agentts-agent">{state.agent}</span>
        )}
        {showProvenance && state.model && <span className="agentts-model">{state.model}</span>}
        {showProvenance && state.effort && <span className="agentts-model">{state.effort}</span>}
        {/* No "session" caption — a short mono id is not something a user has
            to be told the name of. */}
        <span className="agentts-sid" title={state.sessionId}>{shortSession(state.sessionId)}</span>
        <span className="agentts-count">{state.events.length} event{state.events.length === 1 ? '' : 's'}</span>
      </span>
    </div>
  )
}

function JumpLatestButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
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
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 5l4 4 4-4" />
        <path d="M4 13.25h8" />
      </svg>
    </button>
  )
}

function ExternalSessionRow({ session }: { session: ExternalSessionActivity }) {
  const { opening, error, open } = useOpenAgentApp()
  const desktopAgent = clientKindToDesktopAgent(session.clientKind)
  const runningElapsed = useElapsed(session.status === 'running' ? session.startedAt : undefined)
  const fixedElapsed = session.status === 'running'
    ? null
    : durationBetween(session.startedAt, session.endedAt)
  const elapsed = runningElapsed ?? fixedElapsed
  const agent = clientLabel(session.clientKind, 'External agent')
  const label = 'External session'
  const tone = externalSessionTone(session.status)
  const running = session.status === 'running'
  const actionLabel = `Open ${agent}`

  return (
    <li
      className="agentts-sysrow agentts-extrow"
      data-status={session.status}
      data-testid="external-session-activity"
      role={running ? 'status' : undefined}
      aria-label={[label, session.message, elapsed ? `${elapsed} elapsed` : null].filter(Boolean).join('. ')}
    >
      {running ? (
        <span className="agentts-worknode" aria-hidden="true" />
      ) : (
        <span
          className="agentts-node agentts-extnode"
          aria-hidden="true"
          style={{ color: tone, borderColor: `color-mix(in srgb, ${tone} 48%, var(--border-default))` }}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            {session.status === 'done' || session.status === 'ready'
              ? <path d="M3.5 8.5l3 3 6-6.5" />
              : session.status === 'failed'
                ? <path d="M5 5l6 6M11 5l-6 6" />
                : <path d="M4.5 8h7" />}
          </svg>
        </span>
      )}
      <div className="agentts-extbody">
        <div className="agentts-exthead">
          <span className="agentts-label agentts-extlabel" style={{ color: tone }}>{label}</span>
          {elapsed && <span className="agentts-worktime" data-testid="external-session-elapsed">{elapsed}</span>}
        </div>
        <div className="agentts-extline">
          <span className="agentts-extmessage" title={session.conversationName}>{session.message}</span>
          {session.sessionUrl ? (
            <a
              href={session.sessionUrl}
              target="_blank"
              rel="noreferrer"
              className="agentts-extaction"
            >
              {actionLabel} <span aria-hidden>→</span>
            </a>
          ) : desktopAgent ? (
            <button
              type="button"
              className="agentts-extaction"
              disabled={opening !== null}
              onClick={() => open(desktopAgent)}
            >
              {opening ? 'Opening…' : actionLabel} {!opening && <span aria-hidden>→</span>}
            </button>
          ) : null}
        </div>
        {error && <span className="agentts-exterror">{error}</span>}
      </div>
    </li>
  )
}

function externalSessionTone(status: ExternalSessionActivity['status']): string {
  if (status === 'done' || status === 'ready') return 'var(--success)'
  if (status === 'failed') return 'var(--danger)'
  if (status === 'aborted') return 'var(--text-muted)'
  return 'var(--running)'
}

function durationBetween(startIso: string | undefined, endIso: string | undefined): string | null {
  if (!startIso || !endIso) return null
  const startedAt = Date.parse(startIso)
  const endedAt = Date.parse(endIso)
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return null
  return formatElapsedSeconds((endedAt - startedAt) / 1000)
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

function sourceIdentityKey(source: AgentSessionSource): string {
  if (source.kind === 'run') return `run:${source.runId}`
  if (source.kind === 'benchmark') return `benchmark:${source.benchmarkId}`
  if (source.kind === 'portify') return `portify:${source.workflowId}`
  if (source.kind === 'coverage') return `coverage:${source.jobId}`
  if (source.kind === 'evaluation') return `evaluation:${source.taskId}`
  if (source.kind === 'flight') return `flight:${source.flightId}:${source.stage}`
  return `flight-plan:${source.taskId}`
}
