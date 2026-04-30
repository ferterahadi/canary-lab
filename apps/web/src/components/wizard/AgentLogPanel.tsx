import { useEffect, useRef, useState } from 'react'
import { connectDraftAgent } from '../../api/draft-socket'

interface Props {
  draftId: string
  // Optional initial buffer (e.g. the tail captured by the REST endpoint
  // before the WS connection completes). Appended above the live stream.
  initialBuffer?: string
}

// Lightweight monospace live-stream panel for wizard agent stdout. Not xterm
// — we don't need PTY semantics here, just append-only chunks. Auto-scrolls
// while the user is at the bottom; if they scroll up we leave them put.
export function AgentLogPanel({ draftId, initialBuffer }: Props) {
  const [text, setText] = useState(initialBuffer ?? '')
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

  return (
    <pre
      ref={containerRef}
      onScroll={handleScroll}
      className="h-64 overflow-auto rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-3 font-mono text-[11px] leading-snug text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap"
    >
      {text || <span className="text-zinc-400 dark:text-zinc-600">Waiting for agent output…</span>}
    </pre>
  )
}
