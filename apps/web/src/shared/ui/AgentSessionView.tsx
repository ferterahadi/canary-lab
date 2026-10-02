import { sourceIdentityKey, sourceCacheKey, type AgentSessionIdentity } from '@/shared/api/agent-session-source'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as discoveryRepairApi from '@/shared/api/discovery-repair'
import * as agentSessionsApi from '@/shared/api/agent-sessions'
import * as benchmarkApi from '@/shared/api/benchmark'
import * as portifyApi from '@/shared/api/portify'
import * as coverageApi from '@/shared/api/coverage'
import * as flightsApi from '@/shared/api/flights'
import { isAgentSessionAbsence } from '@/shared/api/agent-sessions'
import type {
  AgentSessionAbsence,
  AgentSessionEvent,
  AgentSessionResponse,
  SubagentThread,
} from '@/shared/api/agent-sessions'
import { connectAgentSessionStream } from '@/shared/api/agent-session-socket'
import { formatElapsedSeconds } from '@/shared/lib/format'
import { clientKindToDesktopAgent, clientLabel, type ExternalClientKind } from './external-client-branding'
import { useOpenAgentApp } from './ExternalAgentCard'
import { EventRow, SystemRow, groupSystemLines, shortSession, Timestamp } from './AgentSessionRows'
import { EmptyGlyph, EmptyState } from './EmptyState'
import { EMPTY_COPY, type EmptyCopy } from './empty-state-copy'
import { chronologicalActivity, activityDate, type ActivityIdentity } from './agent-activity-timeline'
import { TIMELINE_CSS } from './agent-session-css'

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

export type AgentSessionSource = AgentSessionIdentity & { live?: boolean }

export interface ExternalSessionActivity {
  taskId?: string
  actionLabel?: string
  clientKind: ExternalClientKind
  sessionId?: string
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
 *  `startedAt` dates the session header; each event retains its CLI timestamp. */
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
  /** Legacy partitions remain accepted from callers; every individual line is
   * merged with session events by its timestamp before rendering. */
  systemRows?: { pre: string[]; between?: string[][]; post: string[] }
  /** External work contributes dated start and terminal lifecycle events. */
  externalSessions?: ExternalSessionActivity[]
  /** Host-supplied copy for the "there is no session" state. A host usually
   *  knows WHY there's no transcript ("this run passed, so no repair agent was
   *  ever spawned") — far more use than the generic fallback below. */
  empty?: EmptyCopy & { detail?: ReactNode }
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

export function AgentSessionView(props: Props) {
  const identity = props.sessionSources?.length ? 'history'
    : props.source ? sourceIdentityKey(props.source) : 'system-only'
  return <ChronologicalSessionView key={identity} {...props} />
}

interface LoadedSession {
  absence: AgentSessionAbsence | null
  state: ViewState | null
  loading: boolean
  error: string | null
}

/** The same loader serves standalone and interleaved history views. */
function useAgentSession(source: AgentSessionSource): LoadedSession {
  const [state, setState] = useState<ViewState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [absence, setAbsence] = useState<AgentSessionAbsence | null>(null)
  const [loading, setLoading] = useState(true)
  // Stable key for the effect dependencies — destructured rather than the
  // whole object so a new prop reference each render doesn't restart the WS.
  const sourceKey = useMemo(() => sourceCacheKey(source), [source])

  useEffect(() => {
    let cancelled = false
    let conn: { close(): void } | null = null
    setError(null)
    setAbsence(null)
    setLoading(true)

    const applySnapshot = (snapshot: AgentSessionResponse | AgentSessionAbsence | null): void => {
      if (cancelled) return
      if (!snapshot || isAgentSessionAbsence(snapshot)) {
        setAbsence(snapshot ?? { absent: true, reason: null })
        // No log yet on disk, or a definitive "never recorded". Keep waiting if
        // live; otherwise show the empty state.
        setState((previous) => previous && (previous.sessionId || previous.events.length > 0)
          ? previous
          : { agent: null, sessionId: '', events: [], subagents: new Map() })
        return
      }
      setAbsence(null)
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
      switch (source.kind) {
        case 'discovery-repair': return discoveryRepairApi.getDiscoveryRepairAgentSession(source.taskId)
        case 'run': return agentSessionsApi.getAgentSession(source.runId)
        case 'benchmark': return benchmarkApi.getBenchmarkAgentSession(source.benchmarkId)
        case 'portify': return portifyApi.getPortifyAgentSession(source.workflowId)
        case 'coverage': return coverageApi.getCoverageAgentSession(source.jobId)
        case 'evaluation': return coverageApi.getEvaluationAgentSession(source.taskId)
        case 'flight': return flightsApi.getFlightAgentSession(source.flightId, source.stage)
        case 'flight-plan': return flightsApi.getFlightPlanAgentSession(source.taskId)
      }
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
        let receivedCount = snapshot && !isAgentSessionAbsence(snapshot) ? snapshot.events.length : 0
        let snapshotLen = receivedCount
        let seenFromWs = 0
        conn = connectAgentSessionStream({
          source,
          onSession: (session) => {
            if (cancelled) return
            setError(null)
            setAbsence(null)
            snapshotLen = receivedCount
            seenFromWs = 0
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
            receivedCount += 1
            setError(null)
            setAbsence(null)
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

  return useMemo(() => ({ state, loading, error, absence }), [state, loading, error, absence])
}

function SessionLoader({ source, report }: {
  source: AgentSessionSource
  report: (key: string, loaded: LoadedSession) => void
}) {
  const loaded = useAgentSession(source)
  const key = sourceIdentityKey(source)
  useEffect(() => { report(key, loaded) }, [key, loaded, report])
  return null
}

type TimelineRow = ActivityIdentity & (
  | { kind: 'event'; event: AgentSessionEvent; state: ViewState; label?: string }
  | { kind: 'system'; line: string }
  | { kind: 'notice'; label: string; message: string; error?: string }
  | { kind: 'external'; session: ExternalSessionActivity; phase: 'start' | 'end' }
  | { kind: 'header'; state: ViewState; segment: AgentSessionSegmentSource; showProvenance: boolean }
)

function ChronologicalSessionView({ source, sessionSources, systemRows, externalSessions = [], empty }: Props) {
  const segments = sessionSources?.length ? sessionSources : source ? [{ source }] : []
  const [loaded, setLoaded] = useState<Record<string, LoadedSession>>({})
  const report = useCallback((key: string, value: LoadedSession) => {
    setLoaded((previous) => previous[key] === value ? previous : { ...previous, [key]: value })
  }, [])
  const scrollerRef = useRef<HTMLDivElement>(null)
  const followingLatestRef = useRef(true)
  const anchorRef = useRef<{ id: string; top: number } | null>(null)
  const [showJumpLatest, setShowJumpLatest] = useState(false)
  const sys = systemRows ?? NO_SYSTEM_ROWS
  const items: TimelineRow[] = []
  let baseline: string | undefined
  for (const segment of segments) {
    const key = sourceIdentityKey(segment.source)
    const state = loaded[key]?.state
    if (!state) continue
    const fingerprint = `${state.agent}|${state.model ?? ''}|${state.effort ?? ''}`
    const showProvenance = baseline === undefined || baseline !== fingerprint
    baseline ??= fingerprint
    if (state.agent && state.sessionId) items.push({
      kind: 'header', id: `${key}:header`, source: key, sequence: -1,
      timestamp: segment.startedAt ?? state.events[0]?.timestamp, state, segment, showProvenance,
    })
    state.events.forEach((event, index) => items.push({
      kind: 'event', id: `${key}:event:${index}`, source: key, sequence: index,
      timestamp: event.timestamp, event, state, label: segment.label,
    }))
  }
  const occurrences = new Map<string, number>()
  for (const line of [...sys.pre, ...(sys.between ?? []).flat(), ...sys.post]) {
    const occurrence = occurrences.get(line) ?? 0
    occurrences.set(line, occurrence + 1)
    items.push({ kind: 'system', id: `system:${line}:${occurrence}`, source: 'system', sequence: items.length,
      timestamp: /^\[[\w-]+@([^\]]+)\]/.exec(line)?.[1], line })
  }
  externalSessions.forEach((session, index) => {
    const key = session.taskId ? `external:${session.taskId}` : `external:${session.sessionId ?? session.clientKind}:${session.startedAt ?? index}`
    items.push({ kind: 'external', id: `${key}:start`, source: key, sequence: 0,
      timestamp: session.startedAt, session, phase: 'start' })
    if (session.status !== 'running') items.push({ kind: 'external', id: `${key}:end`, source: key, sequence: 1,
      timestamp: session.endedAt, session, phase: 'end' })
  })
  // Empty illustrations belong to the whole rail. A missing source inside a
  // populated rail remains visible without claiming that the task itself failed.
  if (items.length > 0) {
    for (const segment of segments) {
      const key = sourceIdentityKey(segment.source)
      const session = loaded[key]
      const notice = transcriptNotice(session, segment.source.live === true)
      if (notice) items.push({
        kind: 'notice', id: `${key}:notice`, source: key, sequence: -0.5,
        timestamp: segment.startedAt ?? session?.state?.events[0]?.timestamp,
        label: segment.label ?? 'Agent transcript', ...notice,
      })
    }
  }
  const rows = chronologicalActivity(items)
  const dates = new Set(rows.map((row) => activityDate(row.timestamp)))
  const captureAnchor = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const first = [...el.querySelectorAll<HTMLElement>('[data-activity-id]')]
      .find((row) => row.getBoundingClientRect().bottom > top)
    anchorRef.current = first ? { id: first.dataset.activityId!, top: first.getBoundingClientRect().top - top } : null
  }, [])
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (followingLatestRef.current) el.scrollTop = el.scrollHeight
    else if (anchorRef.current) {
      const anchor = anchorRef.current
      const row = [...el.querySelectorAll<HTMLElement>('[data-activity-id]')].find((node) => node.dataset.activityId === anchor.id)
      if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.top
    }
    captureAnchor()
  })
  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    followingLatestRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 16
    setShowJumpLatest(!followingLatestRef.current)
    captureAnchor()
  }
  const liveSegment = segments.find((segment) => segment.source.live)
  const failure = segments.map((segment) => loaded[sourceIdentityKey(segment.source)]?.error).find(Boolean)
  const loading = segments.some((segment) => !loaded[sourceIdentityKey(segment.source)] || loaded[sourceIdentityKey(segment.source)].loading)
  let previousDate: string | undefined
  return (
    <div className="relative flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-base)' }}>
      <style>{TIMELINE_CSS}</style>
      {segments.map((segment) => <SessionLoader key={sourceIdentityKey(segment.source)} source={segment.source} report={report} />)}
      <div ref={scrollerRef} onScroll={onScroll} className="h-full min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && <EmptyState {...(failure ? EMPTY_COPY.agentUnreadable : loading ? EMPTY_COPY.agentLoading : liveSegment ? EMPTY_COPY.agentWaiting : empty ?? EMPTY_COPY.agentNone)} detail={failure ?? empty?.detail} />}
        <ol className="agentts-rail">
          {rows.map((row) => {
            const date = activityDate(row.timestamp)
            const dateHeading = date !== previousDate && (dates.size > 1 || date === 'Time unavailable')
            previousDate = date
            return <Fragment key={row.id}>
              {dateHeading && <li className="agentts-head" data-testid="activity-date" role="presentation">{date}</li>}
              {row.kind === 'header' ? <li data-activity-id={row.id} data-testid="agent-session-segment" data-session-label={row.segment.label}>
                <SessionHeader state={row.state} live={row.segment.source.live === true} label={row.segment.label} embedded={segments.length > 1} showProvenance={row.showProvenance} />
              </li> : row.kind === 'event' ? <EventRow activityId={row.id} event={row.event} subagents={row.state.subagents}
                provenance={segments.length > 1 ? `${row.label ?? ''} · ${row.state.model ?? row.state.agent ?? ''} · ${shortSession(row.state.sessionId)}` : undefined} />
                : row.kind === 'notice' ? <li className="agentts-sysrow" data-activity-id={row.id} data-testid="transcript-notice">
                  <div className="agentts-rowhead"><span className="agentts-label">{row.label}</span></div>
                  <div className="agentts-prose" role={row.error ? 'alert' : 'status'}>{row.message}</div>
                  {row.error && <TranscriptError text={row.error} />}
                </li> : row.kind === 'system' ? <SystemRow activityId={row.id} group={groupSystemLines([row.line])[0]} />
                  : <ExternalSessionRow activityId={row.id} session={row.session} phase={row.phase} />}
            </Fragment>
          })}
          {liveSegment && <LiveTail {...pendingWork(loaded[sourceIdentityKey(liveSegment.source)]?.state?.events ?? [])} />}
        </ol>
      </div>
      {showJumpLatest && <JumpLatestButton onClick={() => {
        const el = scrollerRef.current
        if (el) el.scrollTop = el.scrollHeight
        followingLatestRef.current = true
        setShowJumpLatest(false)
      }} />}
    </div>
  )
}

function transcriptNotice(session: LoadedSession | undefined, live: boolean): { message: string; error?: string } | null {
  if (session?.error) return { message: 'Transcript could not be read.', error: session.error }
  if (session?.state?.events.length) return null
  if (!session || session.loading) return { message: 'Loading transcript…' }
  if (live) return { message: 'Waiting for transcript…' }
  if (session.absence?.reason === 'session-log-missing') return { message: 'Transcript file unavailable for this attempt.' }
  return { message: 'No transcript recorded for this attempt.' }
}

function TranscriptError({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return <>
    <button type="button" className="agentts-morebtn" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      {expanded ? 'Hide read error' : 'Show read error'}
    </button>
    {expanded && <pre className="agentts-pre">{text}</pre>}
  </>
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
   *  model on its first header. */
  showProvenance: boolean
}) {
  return (
    <div className="agentts-head" data-sticky={embedded ? 'false' : 'true'} data-testid="agent-session-header">
      {label && <span className="agentts-session-label" data-testid="agent-session-label">{label}</span>}
      <span className="agentts-mode" data-live={live ? 'true' : 'false'} data-testid="agent-session-mode">
        <span className="agentts-statusdot" aria-hidden="true" />
        {live ? 'Live' : 'History'}
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

function ExternalSessionRow({ session, phase, activityId }: { session: ExternalSessionActivity; phase: 'start' | 'end'; activityId: string }) {
  const { opening, error, open } = useOpenAgentApp()
  const desktopAgent = clientKindToDesktopAgent(session.clientKind)
  const runningElapsed = useElapsed(session.status === 'running' ? session.startedAt : undefined)
  const fixedElapsed = session.status === 'running'
    ? null
    : durationBetween(session.startedAt, session.endedAt)
  const elapsed = phase === 'end' ? fixedElapsed : session.status === 'running' ? runningElapsed : null
  const agent = clientLabel(session.clientKind, 'External agent')
  const label = session.actionLabel ?? 'External agent session'
  const tone = phase === 'start' && session.status !== 'running' ? 'var(--text-muted)' : externalSessionTone(session.status)
  const running = phase === 'start' && session.status === 'running'
  const actionLabel = `Open ${agent}`
  const message = phase === 'start' && !running ? `${label} started.` : session.message
  const lifecycle = phase === 'start' ? running ? 'Running' : 'Started'
    : session.status === 'ready' ? 'Result ready' : session.status === 'done' ? 'Completed'
    : session.status === 'failed' ? 'Failed' : 'Stopped'
  const aria = [label, agent, session.sessionId ? `session ${session.sessionId}` : null, message, elapsed ? `${elapsed} elapsed` : null]
    .filter(Boolean)
    .join('. ')

  return (
    <li
      className="agentts-sysrow agentts-extrow"
      data-status={phase === 'start' ? running ? 'running' : 'started' : session.status}
      data-activity-id={activityId}
      data-testid={phase === 'start' && !running ? 'external-session-start' : 'external-session-activity'}
      role={running ? 'status' : undefined}
      aria-label={aria}
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
            {phase === 'start' ? <circle cx="8" cy="8" r="3" /> : session.status === 'done' || session.status === 'ready'
              ? <path d="M3.5 8.5l3 3 6-6.5" />
              : session.status === 'failed'
                ? <path d="M5 5l6 6M11 5l-6 6" />
                : <path d="M4.5 8h7" />}
          </svg>
        </span>
      )}
      <div className="agentts-extbody">
        <div className="agentts-exthead">
          <span className="agentts-label agentts-extlabel" style={{ color: tone }}>{label} · {lifecycle}</span>
          <span className="agentts-extagent" data-testid="external-session-client">{agent}</span>
          {session.sessionId && (
            <span className="agentts-sid" data-testid="external-session-id" title={session.sessionId}>
              {shortSession(session.sessionId)}
            </span>
          )}
          <Timestamp value={(phase === 'start' ? session.startedAt : session.endedAt) ?? ''} />
          {elapsed && (phase === 'end' || running) && <span className="agentts-worktime" data-testid="external-session-elapsed">{elapsed}</span>}
        </div>
        <div className="agentts-extline">
          <span className="agentts-extmessage" title={session.conversationName}>{message}</span>
          {session.sessionUrl ? (
            <a
              href={session.sessionUrl}
              target="_blank"
              rel="noreferrer"
              className="agentts-extaction"
              aria-label={`${actionLabel} session`}
            >
              {actionLabel} <span aria-hidden>→</span>
            </a>
          ) : desktopAgent ? (
            <button
              type="button"
              className="agentts-extaction"
              title={`No exact session link was provided; opens the ${agent} app.`}
              disabled={opening !== null}
              onClick={() => open(desktopAgent)}
            >
              {opening ? 'Opening…' : `Open ${agent} app`} {!opening && <span aria-hidden>→</span>}
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
