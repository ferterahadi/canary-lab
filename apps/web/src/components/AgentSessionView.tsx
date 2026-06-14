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
  | { kind: 'benchmark'; benchmarkId: string; live?: boolean }
  | { kind: 'portify'; workflowId: string; live?: boolean }

interface Props {
  source: AgentSessionSource
}

interface ViewState {
  agent: 'claude' | 'codex' | null
  sessionId: string
  model?: string
  effort?: string
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
      setState({ agent: snapshot.agent, sessionId: snapshot.sessionId, model: snapshot.model, effort: snapshot.effort, events: snapshot.events })
    }

    const fetchSnapshot = async (): Promise<AgentSessionResponse | null> => {
      if (source.kind === 'run') return api.getAgentSession(source.runId)
      if (source.kind === 'benchmark') return api.getBenchmarkAgentSession(source.benchmarkId)
      if (source.kind === 'portify') return api.getPortifyAgentSession(source.workflowId)
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
                : { kind: 'draft', draftId: source.draftId, stage: source.stage },
          onSession: (session) => {
            if (cancelled) return
            setState((prev) => prev
              ? { ...prev, agent: session.agent, sessionId: session.sessionId, model: session.model, effort: session.effort }
              : { agent: session.agent, sessionId: session.sessionId, model: session.model, effort: session.effort, events: [] })
          },
          onEvent: (event) => {
            if (cancelled) return
            // The first `snapshotLen` events the WS sends are replay of what
            // we already have. Drop them; append the rest.
            seenFromWs += 1
            if (seenFromWs <= snapshotLen) return
            setState((prev) => {
              if (!prev) return { agent: null, sessionId: '', events: [event] }
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
      <style>{TIMELINE_CSS}</style>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="h-full min-h-0 flex-1 overflow-y-auto"
      >
        {state.agent && state.sessionId && (
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
          {state.events.map((event: AgentSessionEvent, idx: number) => (
            <EventRow key={idx} event={event} />
          ))}
        </ol>
      </div>
      {showJumpLatest && (
        <button
          type="button"
          onClick={jumpLatest}
          aria-label="Jump to latest"
          title="Jump to latest"
          className="absolute bottom-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-blue-600/85 transition-all duration-150 hover:text-blue-600 hover:[box-shadow:0_4px_14px_color-mix(in_srgb,black_24%,transparent)] dark:text-blue-300/85 dark:hover:text-blue-200"
          style={{
            background: 'color-mix(in srgb, var(--bg-elevated) 94%, transparent)',
            border: '1px solid color-mix(in srgb, var(--border-focus) 32%, var(--border-default))',
            boxShadow: '0 2px 10px color-mix(in srgb, black 20%, transparent)',
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
  return `draft:${source.draftId}:${source.stage}:${source.live ? '1' : '0'}`
}

// ─── Timeline rows ───────────────────────────────────────────────────────────
// Each event is a node on a single vertical rail: a typed marker (role/tool
// glyph) + its content. Tool calls/results collapse to one mono line and
// disclose their full payload; prose reads as a clean transcript.

function EventRow({ event }: { event: AgentSessionEvent }) {
  return (
    <li className="agentts-row" data-kind={event.kind}>
      <NodeMarker event={event} />
      <EventBody event={event} />
    </li>
  )
}

const NODE_ACCENT: Record<AgentSessionEvent['kind'], string> = {
  'user-message': 'var(--accent-cyan, #22d3ee)',
  'assistant-message': 'var(--accent-violet, #a78bfa)',
  'assistant-thinking': 'var(--text-muted)',
  'tool-call': 'var(--accent-amber, #fbbf24)',
  'tool-result': 'var(--text-muted)',
}

function NodeMarker({ event }: { event: AgentSessionEvent }) {
  const isError = event.kind === 'tool-result' && event.isError === true
  const accent = isError ? 'var(--accent-rose, #fb7185)' : NODE_ACCENT[event.kind]
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

function EventBody({ event }: { event: AgentSessionEvent }) {
  switch (event.kind) {
    case 'user-message':
      return <PromptBody text={event.text} timestamp={event.timestamp} />
    case 'assistant-message':
      return <ProseBody label="Assistant" text={event.text} timestamp={event.timestamp} />
    case 'assistant-thinking':
      return <ThinkingBody text={event.text} timestamp={event.timestamp} />
    case 'tool-call':
      return <ToolCallBody name={event.name} input={event.input} timestamp={event.timestamp} toolId={event.toolId} />
    case 'tool-result':
      return <ToolResultBody output={event.output} isError={event.isError} timestamp={event.timestamp} toolId={event.toolId} />
  }
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
      <div className="agentts-prose">{text}</div>
    </>
  )
}

const CLAMP_3: React.CSSProperties = {
  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
}

function PromptBody({ text, timestamp }: { text: string; timestamp: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 260
  return (
    <>
      <RowHead label="Prompt" timestamp={timestamp} />
      <div className="agentts-prose" style={!expanded && long ? CLAMP_3 : undefined}>{text}</div>
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
      {expanded && <div className="agentts-thinkbody">{text}</div>}
    </div>
  )
}

function ToolCallBody({ name, input, timestamp, toolId }: { name: string; input: unknown; timestamp: string; toolId: string }) {
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
      </div>
    </>
  )
}

function ToolResultBody({ output, isError, timestamp, toolId }: { output: string; isError?: boolean; timestamp: string; toolId: string }) {
  const [expanded, setExpanded] = useState(false)
  const firstLine = output.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  const preview = firstLine.length > 140 ? firstLine.slice(0, 137) + '…' : firstLine
  return (
    <>
      <RowHead label={isError ? 'Tool error' : 'Result'} timestamp={timestamp} />
      <div className="agentts-tool" style={isError ? { borderColor: 'color-mix(in srgb, var(--accent-rose, #fb7185) 45%, var(--border-default))' } : undefined}>
        <button type="button" className="agentts-toolbtn" onClick={() => setExpanded((v) => !v)} title={toolId}>
          <span className="agentts-tooltarget" style={{ color: isError ? 'var(--accent-rose, #fb7185)' : 'var(--text-secondary)' }}>
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
.agentts-think{margin-top:1px}
.agentts-thinkbtn{display:inline-flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.07em;font-weight:600;padding:0}
.agentts-thinkbody{margin-top:6px;color:var(--text-muted);font-size:12px;line-height:1.55;font-style:italic;white-space:pre-wrap;border-left:2px solid var(--border-default);padding-left:11px}
@keyframes agentts-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.agentts-row{animation:none}}
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
