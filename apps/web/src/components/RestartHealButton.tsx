import { useState } from 'react'
import * as api from '../api/client'
import { ApiError } from '../api/client'

// Shared terminal-run restart action. It keeps the same run id and asks the
// server to retest failed, skipped, and pending tests before any full-suite
// fallback.

function formatRestartError(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = (e.body as { reason?: unknown })?.reason
    if (typeof reason === 'string') return `Restart failed: ${reason}`
  }
  return e instanceof Error ? e.message : 'Retest failed'
}

interface Props {
  runId: string
  onRestarted?: () => void
  variant?: 'bar' | 'inline'
}

const tooltip = 'Reruns failed, skipped, and pending tests.'

export function RestartHealButton({ runId, onRestarted, variant = 'bar' }: Props) {
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onClick = async (): Promise<void> => {
    if (sending) return
    setSending(true)
    setErr(null)
    try {
      await api.restartRun(runId)
      onRestarted?.()
    } catch (e: unknown) {
      setErr(formatRestartError(e))
    } finally {
      setSending(false)
    }
  }

  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={sending}
      className="shrink-0 rounded-md px-3 py-1.5 text-xs"
      title={tooltip}
      aria-label={`Retest Remaining: ${tooltip}`}
      style={{
        color: 'var(--border-focus)',
        border: '1px solid color-mix(in srgb, var(--border-focus) 40%, transparent)',
        background: 'color-mix(in srgb, var(--border-focus) 8%, transparent)',
        opacity: sending ? 0.5 : 1,
      }}
    >
      {sending ? 'Retesting...' : 'Retest Remaining'}
    </button>
  )

  if (variant === 'inline') {
    return (
      <div className="flex shrink-0 items-center gap-2">
        {button}
        {err && <span className="text-[11px]" style={{ color: 'var(--danger)' }}>{err}</span>}
      </div>
    )
  }

  return (
    <div
      className="flex min-h-[48px] shrink-0 items-center gap-2 px-3 py-2"
      style={{ borderTop: '1px solid var(--border-default)', background: 'var(--bg-base)' }}
    >
      {button}
      {err && <span className="text-[11px]" style={{ color: 'var(--danger)' }}>{err}</span>}
    </div>
  )
}
