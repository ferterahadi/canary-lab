import { useState } from 'react'
import * as api from '../api/client'

interface Props {
  runId: string
  signalPaths: { rerun: string; restart: string }
}

export function ManualHealBanner({ runId, signalPaths }: Props) {
  const [copied, setCopied] = useState<'rerun' | 'restart' | null>(null)
  const [opening, setOpening] = useState<'claude' | 'codex' | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onCopy = async (which: 'rerun' | 'restart'): Promise<void> => {
    const value = which === 'rerun' ? signalPaths.rerun : signalPaths.restart
    try {
      await navigator.clipboard.writeText(value)
      setCopied(which)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setErr('Could not copy to clipboard')
    }
  }

  const onOpen = async (agent: 'claude' | 'codex'): Promise<void> => {
    setOpening(agent)
    setErr(null)
    try {
      await api.openAgentApp(agent)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : `Could not open ${agent}`)
    } finally {
      setOpening(null)
    }
  }

  const onCancel = async (): Promise<void> => {
    setCancelling(true)
    setErr(null)
    try {
      await api.cancelHealRun(runId)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Cancel failed')
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div
      className="mx-3 mt-3 mb-2 rounded-md p-3 text-xs"
      style={{
        background: 'color-mix(in srgb, #eab308 10%, transparent)',
        border: '1px solid color-mix(in srgb, #eab308 40%, transparent)',
        color: 'var(--text-primary)',
      }}
    >
      <div className="font-medium" style={{ color: '#eab308' }}>
        Tests failed — auto-heal is set to <strong>Manual</strong>
      </div>
      <div className="mt-1.5" style={{ color: 'var(--text-secondary)' }}>
        Open Claude or Codex in this project, type <code>self heal</code>, and
        when done write to one of the per-run signal files below.
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onOpen('claude')}
          disabled={opening !== null}
          className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
          style={{
            color: 'var(--text-primary)',
            border: '1px solid var(--border-default)',
            opacity: opening === 'claude' ? 0.6 : 1,
          }}
        >
          {opening === 'claude' ? 'Opening…' : 'Open Claude'}
        </button>
        <button
          type="button"
          onClick={() => onOpen('codex')}
          disabled={opening !== null}
          className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
          style={{
            color: 'var(--text-primary)',
            border: '1px solid var(--border-default)',
            opacity: opening === 'codex' ? 0.6 : 1,
          }}
        >
          {opening === 'codex' ? 'Opening…' : 'Open Codex'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
          style={{ color: '#ef4444', border: '1px solid color-mix(in srgb, #ef4444 40%, transparent)' }}
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
      <div className="mt-2.5 flex flex-col gap-1">
        <SignalRow
          label="Rerun (test/config-only fix)"
          value={signalPaths.rerun}
          copied={copied === 'rerun'}
          onCopy={() => onCopy('rerun')}
        />
        <SignalRow
          label="Restart (service/app fix)"
          value={signalPaths.restart}
          copied={copied === 'restart'}
          onCopy={() => onCopy('restart')}
        />
      </div>
      {err && <div className="mt-2 text-[11px]" style={{ color: '#ef4444' }}>{err}</div>}
    </div>
  )
}

function SignalRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>{label}:</span>
      <code
        className="flex-1 truncate text-[11px]"
        style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}
        title={value}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
        style={{ color: copied ? '#22c55e' : 'var(--text-muted)', border: '1px solid var(--border-default)' }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
