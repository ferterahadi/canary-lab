import { useEffect, useRef, useState } from 'react'
import { connectDraftAgent } from '../../api/draft-socket'

interface Props {
  draftId: string
  // Optional initial buffer (e.g. the tail captured by the REST endpoint
  // before the WS connection completes). Appended above the live stream.
  initialBuffer?: string
  agent?: 'claude' | 'codex'
  phase?: 'planning' | 'generating' | 'refining'
  status?: 'running' | 'failed' | 'idle'
  compact?: boolean
}

// Lightweight monospace live-stream panel for wizard agent stdout. Not xterm
// — we don't need PTY semantics here, just append-only chunks. Auto-scrolls
// while the user is at the bottom; if they scroll up we leave them put.
export function AgentLogPanel({ draftId, initialBuffer, agent, phase, status = 'running', compact = false }: Props) {
  const [text, setText] = useState(initialBuffer ?? '')
  const [expanded, setExpanded] = useState(!compact)
  const containerRef = useRef<HTMLPreElement | null>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    setText(initialBuffer ?? '')
  }, [initialBuffer])

  useEffect(() => {
    let cancelled = false
    const conn = connectDraftAgent({
      draftId,
      onData: (chunk) => {
        if (cancelled) return
        setText((prev) => prev + chunk)
      },
    })
    return () => {
      cancelled = true
      conn.close()
    }
  }, [draftId])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [text])

  const handleScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
    stickToBottomRef.current = distanceFromBottom < 24
  }

  const latestLine = text.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'Waiting for agent output...'
  const phaseLabel = phase === 'planning'
    ? 'Plan generation'
    : phase === 'generating'
      ? 'Spec generation'
      : phase === 'refining'
        ? 'Draft refinement'
        : 'Agent output'

  return (
    <div className="rounded border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        {status === 'running' && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
        {status === 'failed' && <span className="h-2 w-2 rounded-full bg-rose-500" />}
        {status === 'idle' && <span className="h-2 w-2 rounded-full bg-zinc-400" />}
        <span className="font-medium text-zinc-800 dark:text-zinc-200">{phaseLabel}</span>
        {agent && <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-500 dark:bg-zinc-900">{agent}</span>}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-500">{latestLine}</span>
        {compact && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            {expanded ? 'Hide' : 'Output'}
          </button>
        )}
      </div>
      {expanded && (
        <pre
          ref={containerRef}
          onScroll={handleScroll}
          className="h-64 overflow-auto p-3 font-mono text-[11px] leading-snug text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap"
        >
          {text || <span className="text-zinc-400 dark:text-zinc-600">Waiting for agent output...</span>}
        </pre>
      )}
    </div>
  )
}
