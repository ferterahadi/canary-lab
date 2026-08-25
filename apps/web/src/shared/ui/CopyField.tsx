import { useState } from 'react'

/** The shared mono value + Copy/Copied control used for commands and agent
 * prompts. Clipboard failure is deliberately quiet: the value remains visible
 * and selectable even when the browser denies clipboard access. */
export function CopyField({ value, label, testId, buttonTestId, disabled }: {
  value: string
  label: string
  testId?: string
  /** `data-testid` on the copy control itself — the container's id names the
   *  field, and a test that means to copy has to reach the button. */
  buttonTestId?: string
  /** Blocks the copy while the value would be wrong to paste (e.g. a workflow
   *  whose demo isn't installed). The value stays readable either way. */
  disabled?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // The visible value remains the fallback when clipboard access is unavailable.
    }
  }
  return (
    <div
      data-testid={testId}
      className="mt-1 flex items-stretch overflow-hidden rounded border"
      style={{
        borderColor: 'var(--border-default)',
        background: 'color-mix(in srgb, var(--bg-elevated) 44%, transparent)',
      }}
    >
      <code
        className="min-w-0 flex-1 truncate px-2 py-1 text-[11px]"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
        title={value}
      >
        {value}
      </code>
      <button
        type="button"
        data-testid={buttonTestId}
        disabled={disabled}
        onClick={() => void onCopy()}
        aria-label={`Copy ${label}`}
        className="shrink-0 border-l px-2 text-[10px] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        style={{
          borderColor: 'var(--border-default)',
          color: copied ? 'var(--success)' : 'var(--text-muted)',
          letterSpacing: 0,
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
