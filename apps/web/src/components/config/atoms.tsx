/**
 * Form atoms styled to match the existing terminal/IDE aesthetic — subtle
 * borders, elevated surfaces, mono labels for technical fields. No external
 * UI lib; everything is a thin wrapper over native inputs so the editor
 * stays light and consistent with the rest of the app.
 */
import type { CSSProperties, ReactNode } from 'react'

const inputStyle: CSSProperties = {
  background: 'var(--bg-elevated)',
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
        <span className="min-w-[140px] text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        <span className="flex-1">{children}</span>
        {hint && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{hint}</span>}
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
  rows = 3,
  placeholder,
  id,
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
  id?: string
}) {
  return (
    <textarea
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      className="w-full resize-y rounded-md px-2.5 py-1.5 text-xs outline-none"
      style={inputStyle}
    />
  )
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  disabled,
  id,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  disabled?: boolean
  id?: string
}) {
  return (
    <input
      id={id}
      type="number"
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-24 rounded-md px-2.5 py-1.5 text-xs outline-none"
      style={{ ...inputStyle, opacity: disabled ? 0.55 : 1 }}
    />
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
      className="rounded-md px-2 py-1.5 text-xs outline-none"
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

export function ChevronRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}
