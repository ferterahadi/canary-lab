/**
 * Form atoms styled to match the existing terminal/IDE aesthetic — subtle
 * borders, elevated surfaces, mono labels for technical fields. No external
 * UI lib; everything is a thin wrapper over native inputs so the editor
 * stays light and consistent with the rest of the app.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'

const inputStyle: CSSProperties = {
  backgroundColor: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
}

export function FieldRow({
  label,
  hint,
  htmlFor,
  children,
  layout = 'stacked',
}: {
  label: string
  hint?: string
  htmlFor?: string
  children: ReactNode
  layout?: 'stacked' | 'inline'
}) {
  if (layout === 'inline') {
    return (
      <label htmlFor={htmlFor} className="flex items-center gap-3 py-1.5">
        <span className="min-w-[140px] inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          {label}
          {hint && <HintIcon hint={hint} />}
        </span>
        <span className="flex-1">{children}</span>
      </label>
    )
  }
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1.5 py-1.5">
      <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
        {hint && (
          <span className="ml-2 normal-case tracking-normal" style={{ color: 'var(--text-muted)' }}>
            — {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  )
}

export function HintIcon({ hint, icon, label }: { hint: string; icon?: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const tooltipWidth = 256
    const margin = 8
    let left = rect.left + rect.width / 2 - tooltipWidth / 2
    left = Math.max(margin, Math.min(left, window.innerWidth - tooltipWidth - margin))
    const top = rect.bottom + 6
    setPos({ top, left })
  }, [open])

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOpen((v) => !v)
      }}
    >
      <span
        role="button"
        tabIndex={0}
        aria-label={label ?? hint}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={`inline-flex cursor-help items-center justify-center rounded-full font-bold normal-case ${icon ? 'h-5 w-5' : 'h-3.5 w-3.5 text-[9px]'}`}
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-sans, inherit)',
        }}
      >
        {icon ?? 'i'}
      </span>
      {open && pos && typeof document !== 'undefined'
        ? createPortal(
            <span
              role="tooltip"
              className="pointer-events-none fixed z-[100] w-64 break-words rounded-md px-2 py-1.5 text-[11px] normal-case tracking-normal"
              style={{
                top: pos.top,
                left: pos.left,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              }}
            >
              {hint}
            </span>,
            document.body,
          )
        : null}
    </span>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
  id,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  disabled?: boolean
  id?: string
}) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full rounded-md px-2.5 py-1.5 text-xs outline-none focus:ring-1"
      style={{
        ...inputStyle,
        opacity: disabled ? 0.55 : 1,
      }}
    />
  )
}

export function Textarea({
  value,
  onChange,
  rows,
  minRows,
  maxRows,
  placeholder,
  id,
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  minRows?: number
  maxRows?: number
  placeholder?: string
  id?: string
}) {
  const effectiveRows = rows ?? minRows ?? 3
  const style: CSSProperties = { ...inputStyle }
  if (minRows != null) style.minHeight = `calc(${minRows} * 1lh + 0.75rem + 2px)`
  if (maxRows != null) style.maxHeight = `calc(${maxRows} * 1lh + 0.75rem + 2px)`
  return (
    <textarea
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={effectiveRows}
      placeholder={placeholder}
      className="w-full resize-y rounded-md px-2.5 py-1.5 text-xs outline-none"
      style={style}
    />
  )
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  id,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  id?: string
}) {
  const safe = Number.isFinite(value) ? value : 0
  const clamp = (n: number): number => {
    if (min != null && n < min) return min
    if (max != null && n > max) return max
    return n
  }
  const inc = (): void => onChange(clamp(safe + step))
  const dec = (): void => onChange(clamp(safe - step))

  return (
    <div
      className="inline-flex h-7 w-28 items-stretch overflow-hidden rounded-md"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <button
        type="button"
        aria-label="Decrement"
        onClick={dec}
        disabled={disabled || (min != null && safe <= min)}
        className="flex w-6 items-center justify-center text-xs leading-none disabled:opacity-40"
        style={{
          color: 'var(--text-muted)',
          borderRight: '1px solid var(--border-default)',
        }}
      >
        −
      </button>
      <input
        id={id}
        type="number"
        value={safe}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value)
          onChange(Number.isFinite(n) ? clamp(n) : safe)
        }}
        className="numeric-input min-w-0 flex-1 bg-transparent px-2 text-center text-xs outline-none"
        style={{
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)',
        }}
      />
      <button
        type="button"
        aria-label="Increment"
        onClick={inc}
        disabled={disabled || (max != null && safe >= max)}
        className="flex w-6 items-center justify-center text-xs leading-none disabled:opacity-40"
        style={{
          color: 'var(--text-muted)',
          borderLeft: '1px solid var(--border-default)',
        }}
      >
        +
      </button>
    </div>
  )
}

export function Toggle({
  value,
  onChange,
  id,
}: {
  value: boolean
  onChange: (v: boolean) => void
  id?: string
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-150"
      style={{
        background: value ? 'var(--border-focus)' : 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
      }}
    >
      <span
        className="inline-block h-3.5 w-3.5 transform rounded-full transition-transform duration-150"
        style={{
          background: value ? 'var(--bg-base)' : 'var(--text-muted)',
          transform: value ? 'translateX(20px)' : 'translateX(2px)',
        }}
      />
    </button>
  )
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  id,
  disabled,
}: {
  value: T
  onChange: (v: T) => void
  options: ReadonlyArray<{ value: T; label: string }>
  id?: string
  disabled?: boolean
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className="themed-select w-44 rounded-md py-1.5 pl-2.5 pr-8 text-xs outline-none"
      style={{ ...inputStyle, opacity: disabled ? 0.55 : 1 }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

export function ComplexValueBadge({ source }: { source: string }) {
  return (
    <span
      title={source}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px]"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px dashed var(--border-default)',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span>expr</span>
      <span className="max-w-[260px] truncate">{source}</span>
    </span>
  )
}

export function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div
      className="px-4 py-2 text-[10px] uppercase tracking-wider"
      style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-default)' }}
    >
      {children}
    </div>
  )
}

export function IconButton({
  onClick,
  ariaLabel,
  title,
  children,
  variant = 'ghost',
}: {
  onClick: () => void
  ariaLabel: string
  title?: string
  children: ReactNode
  variant?: 'ghost' | 'danger'
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      onClick={onClick}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors duration-150"
      style={{ color: variant === 'danger' ? '#ef4444' : 'var(--text-muted)' }}
      onMouseEnter={(e) => { e.currentTarget.style.color = variant === 'danger' ? '#ef4444' : 'var(--text-primary)' }}
      onMouseLeave={(e) => { e.currentTarget.style.color = variant === 'danger' ? '#ef4444' : 'var(--text-muted)' }}
    >
      {children}
    </button>
  )
}

export function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export function MinusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

export function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

export function Modal({
  open,
  onClose,
  title,
  width = 480,
  children,
}: {
  open: boolean
  onClose: () => void
  title?: string
  width?: number
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="relative rounded-md"
        style={{
          width,
          maxWidth: '94vw',
          background: 'var(--bg-base)',
          border: '1px solid var(--border-default)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: '1px solid var(--border-default)' }}
          >
            <span
              className="text-[10px] uppercase tracking-wider font-medium"
              style={{ color: 'var(--text-muted)' }}
            >
              {title}
            </span>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              ✕
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
  busy = false,
}: {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'danger'
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} width={420}>
      <div className="px-4 py-3 text-xs" style={{ color: 'var(--text-primary)' }}>
        {message}
      </div>
      <div
        className="flex justify-end gap-2 px-4 py-3"
        style={{ borderTop: '1px solid var(--border-default)' }}
      >
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md px-3 py-1 text-[11px] uppercase tracking-wider"
          style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-md px-3 py-1 text-[11px] uppercase tracking-wider"
          style={{
            color: variant === 'danger' ? '#fff' : 'var(--text-primary)',
            background: variant === 'danger' ? '#ef4444' : 'transparent',
            border: variant === 'danger' ? '1px solid #ef4444' : '1px solid var(--border-default)',
          }}
        >
          {busy ? '…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

export function ChevronRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}
