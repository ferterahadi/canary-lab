import { useCallback, useEffect, useRef, useState } from 'react'

// Small copy-to-clipboard button used by the Portify review/committed screens
// and history dialog. Shows a brief "Copied" confirmation, falls back to a
// hidden-textarea execCommand when the async clipboard API is unavailable
// (non-secure contexts / older browsers). Style is overridable so it can sit in
// both the inline-styled wizard and the dialog.
export function CopyButton({
  value,
  label = 'Copy',
  title,
  style,
}: {
  value: string
  label?: string
  title?: string
  style?: React.CSSProperties
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current) }, [])

  const copy = useCallback(async () => {
    let ok = false
    try {
      await navigator.clipboard.writeText(value)
      ok = true
    } catch {
      ok = legacyCopy(value)
    }
    if (!ok) return
    setCopied(true)
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1400)
  }, [value])

  return (
    <button
      type="button"
      onClick={copy}
      title={title ?? `Copy: ${value}`}
      aria-label={title ?? `Copy ${value}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '4px 9px', fontSize: 11, fontWeight: 600, lineHeight: 1,
        borderRadius: 'var(--radius-md)', cursor: 'pointer',
        background: 'transparent',
        border: `1px solid ${copied ? 'rgb(52,211,153)' : 'var(--border-default)'}`,
        color: copied ? 'rgb(52,211,153)' : 'var(--text-secondary)',
        transition: 'color 120ms ease, border-color 120ms ease',
        ...style,
      }}
    >
      <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
      {copied ? 'Copied' : label}
    </button>
  )
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
