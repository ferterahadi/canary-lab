import type { CSSProperties, ReactNode } from 'react'
import { HintIcon } from './Icons'

export const inputStyle: CSSProperties = {
  backgroundColor: 'var(--bg-elevated)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
}

export function FieldRow({
  label,
  hint,
  hintAsIcon,
  htmlFor,
  children,
  layout = 'stacked',
  labelWidth = 140,
}: {
  label: string
  hint?: string
  /** Render the hint as a compact hover `ⓘ` instead of long inline text.
   *  Keeps dense, hint-heavy forms (e.g. the Service tab) scannable. */
  hintAsIcon?: boolean
  htmlFor?: string
  children: ReactNode
  layout?: 'stacked' | 'inline'
  /** Width (px) of the inline label column. Defaults to 140 for the Service
   *  tab's aligned forms; shrink it for short-label sub-editors (e.g. the
   *  health-check probe fields) so the label sits next to its input instead
   *  of across a dead gap. */
  labelWidth?: number
}) {
  if (layout === 'inline') {
    return (
      <label htmlFor={htmlFor} className="flex items-center gap-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)', minWidth: labelWidth }}>
          {label}
          {hint && <HintIcon hint={hint} />}
        </span>
        <span className="flex-1">{children}</span>
      </label>
    )
  }
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1.5 py-1.5">
      <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
        {hint && hintAsIcon && <HintIcon hint={hint} />}
        {hint && !hintAsIcon && (
          <span className="ml-1 normal-case tracking-normal" style={{ color: 'var(--text-muted)' }}>
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
  testId,
}: {
  value: boolean
  onChange: (v: boolean) => void
  id?: string
  testId?: string
}) {
  return (
    <button
      id={id}
      data-testid={testId}
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-150"
      style={{
        background: value ? 'var(--accent)' : 'var(--bg-elevated)',
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

/** Inline segmented control — all options visible at once, one click to pick.
 *  Use instead of `Select` for short, discoverable choices (2-4 options) where
 *  seeing every option beats a dropdown's hidden list. The active segment uses
 *  `--bg-selected` so it reads clearly even inside an elevated card. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T
  onChange: (v: T) => void
  options: ReadonlyArray<{ value: T; label: string }>
  ariaLabel?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex shrink-0 rounded-md"
      style={{ border: '1px solid var(--border-default)' }}
    >
      {options.map((o, i) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className="px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors"
            style={{
              color: active ? 'var(--text-primary)' : 'var(--text-muted)',
              background: active ? 'var(--bg-selected)' : 'transparent',
              borderLeft: i === 0 ? 'none' : '1px solid var(--border-default)',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
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
