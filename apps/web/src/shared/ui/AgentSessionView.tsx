import type { AgentSessionEvent, SubagentThread } from '@shared/agent-session-types'
import { useNow } from '@/shared/state/use-now'
import { sourceIdentityKey, sourceCacheKey, type AgentSessionIdentity } from '@/shared/api/agent-session-source'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as discoveryRepairApi from '@/shared/api/discovery-repair'
import * as agentSessionsApi from '@/shared/api/agent-sessions'
import * as benchmarkApi from '@/shared/api/benchmark'
import * as portifyApi from '@/shared/api/portify'
import * as coverageApi from '@/shared/api/coverage'
import * as flightsApi from '@/shared/api/flights'
import { isAgentSessionAbsence } from '@/shared/api/agent-sessions'
import type { AgentSessionAbsence, AgentSessionResponse } from '@/shared/api/agent-sessions'
import { connectAgentSessionStream } from '@/shared/api/agent-session-socket'
import { formatElapsedSeconds } from '@/shared/lib/format'
import { clientLabel } from './external-client-branding'
import { ExternalOpenAction, LogRow, SYSTEM_GLYPH, eventGlyph, externalGlyph } from './AgentSessionRows'
import { ActivityLogModal, type LogEntry } from './ActivityLogModal'
import {
  describeEvent, eventSpan, firstLineOf, externalLifecycle, isoSpan, parseSystemLine, shortSession, systemVerb, systemLogId, type ExternalSessionActivity, type LogLine,
} from './activity-log'
import { EmptyGlyph, EmptyState } from './EmptyState'
import { EMPTY_COPY, type EmptyCopy } from './empty-state-copy'
import { chronologicalActivity, activityDate, type ActivityIdentity } from './agent-activity-timeline'
import { TIMELINE_CSS } from './agent-session-css'

// Single agent viewer for every agent surface. Renders the agent CLI's JSONL as
// one chronological rail of single-line rows (`LogRow`) under a divider per
// session; clicking a row opens its full content in `ActivityLogModal`.
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
  /** The entry whose full log is open in the modal. A host that routes it
   *  passes both props; without them the view keeps it locally. */
  openLogId?: string | null
  onOpenLogChange?: (id: string | null) => void
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
  | { kind: 'notice'; label: string; message: string; tone: NoticeTone; error?: string; underHeader: boolean }
  | { kind: 'external'; session: ExternalSessionActivity; phase: 'start' | 'end' }
  | { kind: 'external-header'; session: ExternalSessionActivity }
  | { kind: 'header'; state: ViewState; segment: AgentSessionSegmentSource; showProvenance: boolean }
)

function ChronologicalSessionView({ source, sessionSources, systemRows, externalSessions = [], empty, openLogId, onOpenLogChange }: Props) {
  const segments = sessionSources?.length ? sessionSources : source ? [{ source }] : []
  const [loaded, setLoaded] = useState<Record<string, LoadedSession>>({})
  const report = useCallback((key: string, value: LoadedSession) => {
    setLoaded((previous) => previous[key] === value ? previous : { ...previous, [key]: value })
  }, [])
  const scrollerRef = useRef<HTMLDivElement>(null)
  const followingLatestRef = useRef(true)
  const anchorRef = useRef<{ id: string; top: number } | null>(null)
  const [showJumpLatest, setShowJumpLatest] = useState(false)
  // Which entry's full log is open. A host that routes it (a flight stage's
  // `?log=`) controls it; every other host leaves it local. The highlight is a
  // separate fact: it outlives the modal, so closing it leaves the reader's
  // place marked on the rail.
  const [ownOpenId, setOwnOpenId] = useState<string | null>(null)
  const openId = onOpenLogChange ? openLogId ?? null : ownOpenId
  const setOpenId = onOpenLogChange ?? setOwnOpenId
  const [selectedId, setSelectedId] = useState<string | null>(openId)
  useEffect(() => { if (openId) setSelectedId(openId) }, [openId])
  const openEntry = useCallback((id: string) => {
    setSelectedId(id)
    setOpenId(id)
  }, [setOpenId])
  const sys = systemRows ?? NO_SYSTEM_ROWS
  const items: TimelineRow[] = []
  let baseline: string | undefined
  const headed = new Set<string>()
  for (const segment of segments) {
    const key = sourceIdentityKey(segment.source)
    const state = loaded[key]?.state
    if (!state) continue
    const fingerprint = `${state.agent}|${state.model ?? ''}|${state.effort ?? ''}`
    const showProvenance = baseline === undefined || baseline !== fingerprint
    baseline ??= fingerprint
    if (state.agent && state.sessionId) headed.add(key)
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
    // Hashed: the id rides the `?log=` deep link, and a line can be any length.
    items.push({ kind: 'system', id: systemLogId(line, occurrence), source: 'system', sequence: items.length,
      timestamp: parseSystemLine(line).timestamp, line })
  }
  externalSessions.forEach((session, index) => {
    const key = session.taskId ? `external:${session.taskId}` : `external:${session.sessionId ?? session.clientKind}:${session.startedAt ?? index}`
    // An external session is a session too: it opens with its own divider, the
    // way a spawned agent's transcript does, and its lifecycle rows sit under it.
    items.push({ kind: 'external-header', id: `${key}:header`, source: key, sequence: -1,
      timestamp: session.startedAt, session })
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
        label: segment.label ?? 'Agent transcript', ...notice, underHeader: headed.has(key),
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
  // A routed id for a one-line row (a stale link, a row that became whole)
  // opens nothing — there is nothing beyond the row to show.
  const openRow = openId ? rows.find((row) => row.id === openId && !rowLine(row)?.whole) : undefined
  const openLog = openRow ? logEntryFor(openRow, rows) : null
  // An entry opened from the URL (a refresh, a shared link, a pair link) may sit
  // anywhere in the history: bring its row into view once, so closing the modal
  // leaves the reader at the highlighted row rather than at the latest one.
  const revealedRef = useRef<string | null>(null)
  const revealId = openRow ? openRow.id : null
  useEffect(() => {
    const el = scrollerRef.current
    if (!revealId || !el || revealedRef.current === revealId) return
    revealedRef.current = revealId
    const node = [...el.querySelectorAll<HTMLElement>('[data-activity-id]')].find((row) => row.dataset.activityId === revealId)
    if (!node) return
    const box = el.getBoundingClientRect()
    const at = node.getBoundingClientRect()
    if (at.top >= box.top && at.bottom <= box.bottom) return
    followingLatestRef.current = false
    setShowJumpLatest(true)
    el.scrollTop += at.top - box.top - (box.height - at.height) / 2
    captureAnchor()
  }, [revealId, captureAnchor])
  const liveSegment = segments.find((segment) => segment.source.live)
  const failure = segments.map((segment) => loaded[sourceIdentityKey(segment.source)]?.error).find(Boolean)
  const loading = segments.some((segment) => !loaded[sourceIdentityKey(segment.source)] || loaded[sourceIdentityKey(segment.source)].loading)
  let previousDate: string | undefined
  return (
    // The recessed `--bg-base` well belongs to the transcript, not the pane. An
    // empty view sits on the host's own surface, so its card reads exactly like
    // the Changes and Journal empty states beside it rather than as a dark hole.
    <div className="relative flex h-full min-h-0 flex-col" style={rows.length === 0 ? undefined : { background: 'var(--bg-base)' }}>
      <style>{TIMELINE_CSS}</style>
      {segments.map((segment) => <SessionLoader key={sourceIdentityKey(segment.source)} source={segment.source} report={report} />)}
      <div ref={scrollerRef} onScroll={onScroll} className="h-full min-h-0 flex-1 overflow-y-auto" style={{ scrollbarGutter: 'stable' }}>
        {rows.length === 0 && <EmptyState {...(failure ? EMPTY_COPY.agentUnreadable : loading ? EMPTY_COPY.agentLoading : liveSegment ? EMPTY_COPY.agentWaiting : empty ?? EMPTY_COPY.agentNone)} detail={failure ?? empty?.detail} />}
        {/* No rail under a settled empty state: its bottom padding would overflow
            the scroller and follow-latest would nudge the card off centre. */}
        {(rows.length > 0 || liveSegment) && <ol className="agentts-rail">
          {rows.map((row) => {
            const date = activityDate(row.timestamp)
            const dateHeading = date !== previousDate && (dates.size > 1 || date === 'Time unavailable')
            previousDate = date
            return <Fragment key={row.id}>
              {dateHeading && <li className="agentts-date" data-testid="activity-date" role="presentation">{date}</li>}
              <TimelineItem row={row} selected={row.id === selectedId} onOpen={openEntry} sticky={segments.length + externalSessions.length <= 1} />
            </Fragment>
          })}
          {liveSegment && <LiveTail {...pendingWork(loaded[sourceIdentityKey(liveSegment.source)]?.state?.events ?? [])} />}
        </ol>}
      </div>
      {showJumpLatest && <JumpLatestButton onClick={() => {
        const el = scrollerRef.current
        if (el) el.scrollTop = el.scrollHeight
        followingLatestRef.current = true
        setShowJumpLatest(false)
      }} />}
      {openLog && <ActivityLogModal entry={openLog} onClose={() => setOpenId(null)} onOpenEntry={openEntry} />}
    </div>
  )
}

function TimelineItem({ row, selected, onOpen, sticky }: {
  row: TimelineRow
  selected: boolean
  onOpen: (id: string) => void
  /** A lone session's divider pins while its rows scroll; in a stack each
   *  divider stays where its session starts. */
  sticky: boolean
}) {
  const open = useCallback(() => onOpen(row.id), [onOpen, row.id])
  switch (row.kind) {
    case 'header':
      return <li data-activity-id={row.id} data-testid="agent-session-segment" data-session-label={row.segment.label} className="agentts-divrow">
        <SessionDivider state={row.state} live={row.segment.source.live === true} label={row.segment.label} startedAt={row.segment.startedAt} sticky={sticky} showProvenance={row.showProvenance} />
      </li>
    case 'external-header':
      return <li data-activity-id={row.id} data-testid="external-session-segment" className="agentts-divrow">
        <ExternalSessionDivider session={row.session} sticky={sticky} />
      </li>
    case 'notice':
      // Under its session's divider the notice is just a line. An attempt with
      // no readable transcript has no divider of its own, so the notice stands
      // in for one: same band, its label, and why there are no rows.
      return row.underHeader ? (
        <li className="agentts-notice" data-activity-id={row.id} data-testid="transcript-notice">
          <span className="agentts-noticetext" role={row.error ? 'alert' : 'status'}>{row.message}</span>
          {row.error && <TranscriptError text={row.error} />}
        </li>
      ) : (
        <li className="agentts-divrow" data-activity-id={row.id} data-testid="transcript-notice">
          <div className="agentts-divider" data-sticky="false" data-tone={row.tone}>
            <DividerMark tone={row.tone} />
            <span className="agentts-divlabel">{row.label}</span>
            <span className="agentts-divnote" role={row.error ? 'alert' : 'status'}>{row.message}</span>
          </div>
          {row.error && <div className="agentts-notice"><TranscriptError text={row.error} /></div>}
        </li>
      )
    case 'event': {
      const threads = row.event.kind === 'tool-call' ? row.state.subagents.get(row.event.toolId) : undefined
      return <LogRow activityId={row.id} line={rowLine(row)!} glyph={eventGlyph(row.event, Boolean(threads?.length))}
        timestamp={row.event.timestamp} selected={selected} onOpen={open} />
    }
    case 'system':
      return <LogRow activityId={row.id} line={rowLine(row)!} glyph={SYSTEM_GLYPH}
        timestamp={parseSystemLine(row.line).timestamp ?? ''} selected={selected} onOpen={open} testId="system-row" />
    case 'external': {
      const { session, phase } = row
      return <LogRow activityId={row.id} line={rowLine(row)!}
        glyph={externalGlyph(phase, session.status)} timestamp={(phase === 'start' ? session.startedAt : session.endedAt) ?? ''}
        selected={selected} onOpen={open} testId={phase === 'start' ? 'external-session-start' : 'external-session-end'} />
    }
  }
}

/** What a log row says at rest; null for the dividers and notices. One home,
 *  so the row and the guard on what may open in the modal read the same line. */
function rowLine(row: TimelineRow): LogLine | null {
  switch (row.kind) {
    case 'event':
      return describeEvent(row.event, row.event.kind === 'tool-call' ? row.state.subagents.get(row.event.toolId) : undefined)
    case 'system': {
      // A conductor line usually fits the row and opens nothing; a long one —
      // raw output a producer forwarded — is cut to one line and opens.
      const line = parseSystemLine(row.line)
      const summary = firstLineOf(line.text)
      return { kind: 'system', verb: systemVerb(line.tag), summary, ...(line.text.trim() === summary ? { whole: true } : {}) }
    }
    case 'external': {
      const { session, phase } = row
      const message = phase === 'start' && session.status !== 'running' ? `${session.actionLabel ?? 'External agent session'} started.` : session.message
      return {
        kind: 'system', verb: externalLifecycle(session.status, phase), summary: firstLineOf(message),
        ...(phase === 'end' && session.status === 'failed' ? { danger: true } : {}),
        ...(message.trim() === firstLineOf(message) ? { whole: true } : {}),
      }
    }
    default:
      return null
  }
}

/** The modal's view of a row: the row plus what it needs from its neighbours —
 *  the other half of a tool use, the subagents a call spawned. */
function logEntryFor(row: TimelineRow, rows: readonly TimelineRow[]): LogEntry | null {
  if (row.kind === 'external') return { kind: 'external', id: row.id, session: row.session, phase: row.phase }
  if (row.kind === 'system') return { kind: 'system', id: row.id, line: parseSystemLine(row.line) }
  if (row.kind !== 'event') return null
  const { event, state } = row
  const toolId = event.kind === 'tool-call' || event.kind === 'tool-result' ? event.toolId : undefined
  const pairKind = event.kind === 'tool-call' ? 'tool-result' : 'tool-call'
  const pair = toolId === undefined ? undefined : rows.find((other) => other.kind === 'event' && other.source === row.source
    && other.event.kind === pairKind && other.event.toolId === toolId)
  return {
    kind: 'event', id: row.id, event,
    session: { label: row.label, agent: state.agent, model: state.model, sessionId: state.sessionId },
    ...(event.kind === 'tool-call' && state.subagents.get(event.toolId)?.length ? { threads: state.subagents.get(event.toolId) } : {}),
    ...(pair?.kind === 'event' ? { pair: { id: pair.id, event: pair.event } } : {}),
  }
}

type NoticeTone = 'live' | 'danger' | 'absent'

function transcriptNotice(session: LoadedSession | undefined, live: boolean): { message: string; tone: NoticeTone; error?: string } | null {
  if (session?.error) return { message: 'Transcript could not be read.', tone: 'danger', error: session.error }
  if (session?.state?.events.length) return null
  if (!session || session.loading) return { message: 'Loading transcript…', tone: 'live' }
  if (live) return { message: 'Waiting for transcript…', tone: 'live' }
  if (session.absence?.reason === 'session-log-missing') return { message: 'Transcript file unavailable for this attempt.', tone: 'absent' }
  return { message: 'No transcript recorded for this attempt.', tone: 'absent' }
}

function TranscriptError({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return <>
    <button type="button" className="agentts-morebtn" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      {expanded ? 'Hide read error' : 'Show read error'}
    </button>
    {expanded && <pre className="agentts-plain">{text}</pre>}
  </>
}

/** A model id already names its vendor (`claude-opus-5`, `gpt-5-codex`), so
 *  printing the agent beside it says the same word twice. Name the agent only
 *  when the model can't stand in for it — or when there is no model to read. */
function agentNeedsNaming(agent: string, model?: string): boolean {
  if (!model) return true
  return !model.toLowerCase().includes(agent.toLowerCase())
}

/** Where one session starts. The name is the loudest thing on it; who ran it
 *  (agent, model, session id, event count) sits right beside the name rather
 *  than across the rail, so the rows below no longer repeat it one by one. */
function SessionDivider({ state, live, label, startedAt, sticky, showProvenance }: {
  state: ViewState
  live: boolean
  label?: string
  startedAt?: string
  sticky: boolean
  /** False for a later segment in a stack that already stated this agent and
   *  model on its first divider. */
  showProvenance: boolean
}) {
  const elapsed = useElapsed(live ? startedAt ?? state.events[0]?.timestamp : undefined)
  const terminated = state.events.at(-1)?.kind === 'assistant-message' && (state.events.at(-1) as { apiError?: boolean }).apiError === true
  const span = eventSpan(state.events)
  const status = live ? `Live${elapsed ? ` · ${elapsed}` : ''}` : terminated ? 'Terminated' : `Ended${span ? ` · ${span}` : ''}`
  const tone = live ? 'live' : terminated ? 'danger' : 'settled'
  return (
    <div className="agentts-divider" data-sticky={sticky ? 'true' : 'false'} data-tone={tone} data-testid="agent-session-header">
      <DividerMark tone={tone} />
      <span className="agentts-divlabel" data-testid="agent-session-label">{label ?? (state.agent ? `${state.agent} session` : 'Agent session')}</span>
      <span className="agentts-provenance">
        {showProvenance && state.agent && agentNeedsNaming(state.agent, state.model) && <span className="agentts-agent">{state.agent}</span>}
        {showProvenance && state.model && <span className="agentts-model">{state.model}</span>}
        {showProvenance && state.effort && <span>{state.effort}</span>}
        <span className="agentts-sid" title={state.sessionId}>{shortSession(state.sessionId)}</span>
        <span className="agentts-count">{state.events.length} event{state.events.length === 1 ? '' : 's'}</span>
      </span>
      <span className="agentts-divspace" />
      <span className="agentts-divchip" data-tone={tone} data-live={live ? 'true' : 'false'} data-testid="agent-session-mode">{status}</span>
    </div>
  )
}

/** An external client's session: the same divider, naming the client, with the
 *  one way to read the conversation — open it where it lives. */
function ExternalSessionDivider({ session, sticky }: { session: ExternalSessionActivity; sticky: boolean }) {
  const running = session.status === 'running'
  const elapsed = useElapsed(running ? session.startedAt : undefined)
  const duration = isoSpan(session.startedAt, session.endedAt)
  const status = running ? `Live${elapsed ? ` · ${elapsed}` : ''}` : `${externalLifecycle(session.status, 'end')}${duration ? ` · ${duration}` : ''}`
  const tone = running ? 'live' : session.status === 'failed' ? 'danger' : session.status === 'aborted' ? 'settled' : 'success'
  return (
    <div className="agentts-divider" data-sticky={sticky ? 'true' : 'false'} data-tone={tone} data-testid="external-session-header">
      <DividerMark tone={tone} />
      <span className="agentts-divlabel">{session.actionLabel ?? 'External agent session'}</span>
      <span className="agentts-provenance">
        <span className="agentts-agent">External</span>
        {session.clientKind !== 'other' && <span data-testid="external-session-client">{clientLabel(session.clientKind)}</span>}
        {session.sessionId && <span title={session.sessionId} data-testid="external-session-id">{shortSession(session.sessionId)}</span>}
      </span>
      <span className="agentts-divspace" />
      <ExternalOpenAction session={session} />
      <span className="agentts-divchip" data-tone={tone} data-live={running ? 'true' : 'false'} data-testid="external-session-status">{status}</span>
    </div>
  )
}

function DividerMark({ tone }: { tone: 'live' | 'danger' | 'settled' | 'success' | 'absent' }) {
  if (tone === 'live') return <span className="agentts-divmark agentts-statusdot" data-live="true" aria-hidden="true" />
  return (
    <span className="agentts-divmark" data-tone={tone} aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {tone === 'danger' ? <path d="M5 5l6 6M11 5l-6 6" /> : tone === 'absent' ? <path d="M4.5 8h7" /> : <path d="M3.5 8.5l3 3 6-6.5" />}
      </svg>
    </span>
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
  const now = useNow({ enabled: startedAt !== null, resetKey: startedAt, refreshOnReset: startedAt !== null })
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
