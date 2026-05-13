import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import type { AgentSessionEvent, AgentSessionResponse } from '../api/client'
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

interface Props {
  source: AgentSessionSource
}

const SNAPSHOT_POLL_MS = 1500

interface ViewState {
  agent: 'claude' | 'codex' | null
  sessionId: string
  events: AgentSessionEvent[]
}

export function AgentSessionView({ source }: Props) {
  const [state, setState] = useState<ViewState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const followingLatestRef = useRef(true)
  const [showJumpLatest, setShowJumpLatest] = useState(false)
  // Stable key for the effect dependencies — destructured rather than the
  // whole object so a new prop reference each render doesn't restart the WS.
  const sourceKey = useMemo(() => sourceCacheKey(source), [source])

  useEffect(() => {
    let cancelled = false
    let conn: { close(): void } | null = null
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    setLoading(true)
    setError(null)
    setState(null)

    const applySnapshot = (snapshot: AgentSessionResponse | null): void => {
      if (cancelled) return
      if (!snapshot) {
        // No log yet on disk. Keep waiting if live; otherwise show empty state.
        setState({ agent: null, sessionId: '', events: [] })
        return
      }
      setState({ agent: snapshot.agent, sessionId: snapshot.sessionId, events: snapshot.events })
    }

    const fetchSnapshot = async (): Promise<AgentSessionResponse | null> => {
      if (source.kind === 'run') return api.getAgentSession(source.runId)
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
            : { kind: 'draft', draftId: source.draftId, stage: source.stage },
          onEvent: (event) => {
            if (cancelled) return
            // The first `snapshotLen` events the WS sends are replay of what
            // we already have. Drop them; append the rest.
            seenFromWs += 1
            if (seenFromWs <= snapshotLen) return
            setState((prev) => {
              if (!prev) return { agent: event.kind === 'user-message' || event.kind === 'assistant-message' ? 'claude' : null as never, sessionId: '', events: [event] }
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
        // While live, periodically re-pull the REST snapshot too. This is a
        // belt-and-braces guard for cases where the WS reconnects and the
        // server's replay misses an event that landed between disconnect and
        // reconnect. Also recovers the session id once the file appears.
        const repoll = (): void => {
          if (cancelled || !source.live) return
          fetchSnapshot()
            .then((next) => {
              if (cancelled || !next) return
              if (next.events.length > snapshotLen) {
                snapshotLen = next.events.length
                setState({ agent: next.agent, sessionId: next.sessionId, events: next.events })
              } else if (next.sessionId) {
                setState((prev) => prev && !prev.sessionId
                  ? { ...prev, agent: next.agent, sessionId: next.sessionId }
                  : prev)
              }
            })
            .catch(() => { /* ignore */ })
            .finally(() => {
              if (!cancelled) pollTimer = setTimeout(repoll, SNAPSHOT_POLL_MS)
            })
        }
        pollTimer = setTimeout(repoll, SNAPSHOT_POLL_MS)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      cancelled = true
      if (conn) conn.close()
      if (pollTimer) clearTimeout(pollTimer)
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

  if (error) {
    return (
      <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
        Failed to load session log: {error}
      </div>
    )
  }
  if (loading) {
    return (
      <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading session…
      </div>
    )
  }
  if (!state || (!state.sessionId && state.events.length === 0)) {
    return (
      <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
        {source.live ? 'Waiting for agent output…' : 'No structured session log found.'}
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-base)' }}>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="h-full min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm"
      >
        {state.agent && state.sessionId && (
          <div className="mb-3 text-[11px] uppercase tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>
            Agent: {state.agent} · Session: <span style={{ fontFamily: 'var(--font-mono)' }}>{state.sessionId}</span>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {state.events.map((event: AgentSessionEvent, idx: number) => (
            <EventCard key={idx} event={event} />
          ))}
        </div>
      </div>
      {showJumpLatest && (
        <button
          type="button"
          onClick={jumpLatest}
          className="absolute bottom-3 right-3 rounded bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-700 shadow hover:bg-sky-500/20 dark:text-sky-300"
        >
          Jump latest
        </button>
      )}
    </div>
  )
}

function sourceCacheKey(source: AgentSessionSource): string {
  if (source.kind === 'run') return `run:${source.runId}:${source.live ? '1' : '0'}`
  return `draft:${source.draftId}:${source.stage}:${source.live ? '1' : '0'}`
}

function EventCard({ event }: { event: AgentSessionEvent }) {
  switch (event.kind) {
    case 'user-message':
      return <MessageCard role="User" tone="user" text={event.text} timestamp={event.timestamp} />
    case 'assistant-message':
      return <MessageCard role="Assistant" tone="assistant" text={event.text} timestamp={event.timestamp} />
    case 'assistant-thinking':
      return <ThinkingCard text={event.text} timestamp={event.timestamp} />
    case 'tool-call':
      return <ToolCallCard name={event.name} input={event.input} timestamp={event.timestamp} toolId={event.toolId} />
    case 'tool-result':
      return <ToolResultCard output={event.output} isError={event.isError} timestamp={event.timestamp} toolId={event.toolId} />
  }
}

function MessageCard({ role, tone, text, timestamp }: { role: string; tone: 'user' | 'assistant'; text: string; timestamp: string }) {
  const borderColor = tone === 'user' ? 'var(--accent-cyan, #22d3ee)' : 'var(--accent-violet, #a78bfa)'
  return (
    <div className="border-l-2 pl-3" style={{ borderColor }}>
      <Header label={role} timestamp={timestamp} />
      <div className="whitespace-pre-wrap break-words" style={{ color: 'var(--text-primary)' }}>{text}</div>
    </div>
  )
}

function ThinkingCard({ text, timestamp }: { text: string; timestamp: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border-l-2 pl-3" style={{ borderColor: 'var(--text-muted)' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[11px] uppercase tracking-[0.08em]"
        style={{ color: 'var(--text-muted)' }}
      >
        <span>{expanded ? '▼' : '▶'}</span>
        <span>Thinking</span>
        <Timestamp value={timestamp} />
      </button>
      {expanded && (
        <div
          className="mt-1 whitespace-pre-wrap break-words italic"
          style={{ color: 'var(--text-muted)' }}
        >
          {text}
        </div>
      )}
    </div>
  )
}

function ToolCallCard({ name, input, timestamp, toolId }: { name: string; input: unknown; timestamp: string; toolId: string }) {
  const [expanded, setExpanded] = useState(false)
  const summary = summarizeInput(input)
  return (
    <div className="border-l-2 pl-3" style={{ borderColor: 'var(--accent-amber, #fbbf24)' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1 text-left"
        title={toolId}
      >
        <span style={{ color: 'var(--text-muted)' }}>{expanded ? '▼' : '▶'}</span>
        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{name || '(unnamed tool)'}</span>
        {summary && (
          <span className="truncate" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            ({summary})
          </span>
        )}
        <Timestamp value={timestamp} />
      </button>
      {expanded && (
        <pre
          className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded p-2 text-xs"
          style={{ background: 'var(--bg-elevated, rgba(255,255,255,0.04))', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
        >
          {formatJson(input)}
        </pre>
      )}
    </div>
  )
}

function ToolResultCard({ output, isError, timestamp, toolId }: { output: string; isError?: boolean; timestamp: string; toolId: string }) {
  const [expanded, setExpanded] = useState(false)
  const firstLine = output.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  const preview = firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine
  const borderColor = isError ? 'var(--accent-rose, #fb7185)' : 'var(--text-muted)'
  return (
    <div className="border-l-2 pl-3" style={{ borderColor }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1 text-left"
        title={toolId}
      >
        <span style={{ color: 'var(--text-muted)' }}>{expanded ? '▼' : '▶'}</span>
        <span className="text-[11px] uppercase tracking-[0.08em]" style={{ color: isError ? 'var(--accent-rose, #fb7185)' : 'var(--text-muted)' }}>
          {isError ? 'Tool error' : 'Tool result'}
        </span>
        {preview && (
          <span className="truncate" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            {preview}
          </span>
        )}
        <Timestamp value={timestamp} />
      </button>
      {expanded && (
        <pre
          className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded p-2 text-xs"
          style={{ background: 'var(--bg-elevated, rgba(255,255,255,0.04))', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
        >
          {output || '(empty)'}
        </pre>
      )}
    </div>
  )
}

function Header({ label, timestamp }: { label: string; timestamp: string }) {
  return (
    <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>
      <span>{label}</span>
      <Timestamp value={timestamp} />
    </div>
  )
}

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
