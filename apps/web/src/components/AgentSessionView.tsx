import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { AgentSessionEvent, AgentSessionResponse } from '../api/client'

interface Props {
  runId: string
  pollUntilFound?: boolean
}

// The agent CLI flushes its JSONL on exit; cap retries at ~9s before showing
// the empty-state.
const MAX_POLL_ATTEMPTS = 12
const POLL_INTERVAL_MS = 750

// Renders the normalized heal-agent JSONL as a chat-style timeline. Used on
// the historical replay path (terminal runs, no live broker). Live runs keep
// using the raw xterm pane in PaneTerminal — only after the run finishes do
// we have the agent CLI's full structured log to render from.
export function AgentSessionView({ runId, pollUntilFound = false }: Props) {
  const [data, setData] = useState<AgentSessionResponse | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    setData(undefined)
    setError(null)
    const load = (): void => {
      api.getAgentSession(runId)
        .then((res) => {
          if (cancelled) return
          if (res === null && pollUntilFound && attempts < MAX_POLL_ATTEMPTS) {
            attempts += 1
            timer = setTimeout(load, POLL_INTERVAL_MS)
            return
          }
          setData(res)
        })
        .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    }
    load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [runId, pollUntilFound])

  if (error) {
    return (
      <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
        Failed to load session log: {error}
      </div>
    )
  }
  if (data === undefined) {
    return (
      <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading session…
      </div>
    )
  }
  if (data === null) {
    return (
      <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
        {pollUntilFound ? 'Waiting for structured session log…' : 'No structured session log found for this run.'}
      </div>
    )
  }
  if (data.events.length === 0) {
    return (
      <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
        Session log is empty — agent produced no parseable events.
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-3 text-sm" style={{ background: 'var(--bg-base)' }}>
      <div className="mb-3 text-[11px] uppercase tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>
        Agent: {data.agent} · Session: <span style={{ fontFamily: 'var(--font-mono)' }}>{data.sessionId}</span>
      </div>
      <div className="flex flex-col gap-3">
        {data.events.map((event: AgentSessionEvent, idx: number) => (
          <EventCard key={idx} event={event} />
        ))}
      </div>
    </div>
  )
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
  // Common known fields across both agents' tools.
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
