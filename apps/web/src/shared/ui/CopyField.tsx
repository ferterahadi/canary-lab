import { useClipboardCopy } from '@/shared/state/use-clipboard-copy'

/** The shared mono value + Copy/Copied control used for commands, signal paths
 * and agent prompts. Clipboard failure is quiet by default: the value remains
 * visible and selectable even when the browser denies clipboard access. A
 * caller with its own error line passes `onCopyFailed` to report it there. */
export function CopyField({ value, label, labelPlacement = 'hidden', testId, buttonTestId, disabled, onCopyFailed }: {
  value: string
  label: string
  /** `hidden` names the field to assistive tech only (a caption above already
   *  says what it is); `inline` also prints `label:` before the value, for a
   *  stack of fields that would otherwise be indistinguishable. */
  labelPlacement?: 'hidden' | 'inline'
  testId?: string
  /** `data-testid` on the copy control itself — the container's id names the
   *  field, and a test that means to copy has to reach the button. */
  buttonTestId?: string
  /** Blocks the copy while the value would be wrong to paste (e.g. a workflow
   *  whose demo isn't installed). The value stays readable either way. */
  disabled?: boolean
  onCopyFailed?: () => void
}) {
  const { copy, copiedKey } = useClipboardCopy()
  const copied = copiedKey === value
  const inline = labelPlacement === 'inline'
  const field = (
    <div
      data-testid={inline ? undefined : testId}
      className={`${inline ? 'min-w-0 flex-1' : 'mt-1'} flex items-stretch overflow-hidden rounded border`}
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
        onClick={() => { void copy(value).then((ok) => { if (!ok) onCopyFailed?.() }) }}
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
  if (!inline) return field
  return (
    <div data-testid={testId} className="flex items-center gap-2">
      <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>{label}:</span>
      {field}
    </div>
  )
}
