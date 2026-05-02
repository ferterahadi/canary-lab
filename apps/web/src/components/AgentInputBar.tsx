import { useState, type FormEvent } from 'react'
import * as api from '../api/client'

interface Props {
  runId: string
}

export function AgentInputBar({ runId }: Props) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!text.trim() || sending) return
    setSending(true)
    setErr(null)
    try {
      await api.sendAgentInput(runId, text + '\n')
      setText('')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex items-center gap-2 px-3 py-2"
      style={{ borderTop: '1px solid var(--border-default)', background: 'var(--bg-base)' }}
    >
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Interject — type guidance for the agent…"
        className="flex-1 rounded-md px-2.5 py-1.5 text-xs outline-none"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)',
        }}
      />
      <button
        type="submit"
        disabled={!text.trim() || sending}
        className="rounded-md px-3 py-1.5 text-xs"
        style={{
          color: 'var(--border-focus)',
          border: '1px solid color-mix(in srgb, var(--border-focus) 40%, transparent)',
          background: 'color-mix(in srgb, var(--border-focus) 8%, transparent)',
          opacity: !text.trim() || sending ? 0.5 : 1,
        }}
      >
        {sending ? 'Sending…' : 'Send'}
      </button>
      {err && <span className="text-[11px]" style={{ color: '#ef4444' }}>{err}</span>}
    </form>
  )
}
