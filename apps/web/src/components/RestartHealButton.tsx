import { useState } from 'react'
import * as api from '../api/client'
import { ApiError } from '../api/client'

// Renders under the agent pane only when the heal-agent REPL has stopped
// (terminal state for an auto-heal run). Clicking it spawns a fresh
// orchestrator + REPL via the existing `/agent-input` route — empty data
// triggers the no-orchestrator restart-from-failed path on the server.
// Live guidance is typed directly into the new REPL pane afterwards.

function formatRestartError(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = (e.body as { reason?: unknown })?.reason
    if (typeof reason === 'string') return `Restart failed: ${reason}`
  }
  return e instanceof Error ? e.message : 'Restart failed'
}

interface Props {
  runId: string
  onRestarted?: () => void
}

export function RestartHealButton({ runId, onRestarted }: Props) {
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onClick = async (): Promise<void> => {
    if (sending) return
    setSending(true)
    setErr(null)
    try {
      await api.sendAgentInput(runId, '')
      onRestarted?.()
    } catch (e: unknown) {
      setErr(formatRestartError(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className="flex min-h-[48px] shrink-0 items-center gap-2 px-3 py-2"
      style={{ borderTop: '1px solid var(--border-default)', background: 'var(--bg-base)' }}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={sending}
        className="shrink-0 rounded-md px-3 py-1.5 text-xs"
        style={{
          color: 'var(--border-focus)',
          border: '1px solid color-mix(in srgb, var(--border-focus) 40%, transparent)',
          background: 'color-mix(in srgb, var(--border-focus) 8%, transparent)',
          opacity: sending ? 0.5 : 1,
        }}
      >
        {sending ? 'Restarting…' : 'Restart Heal'}
      </button>
      {err && <span className="text-[11px]" style={{ color: 'var(--danger)' }}>{err}</span>}
    </div>
  )
}
