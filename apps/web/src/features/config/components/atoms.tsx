/**
 * Form atoms styled to match the existing terminal/IDE aesthetic — subtle
 * borders, elevated surfaces, mono labels for technical fields. No external
 * UI lib; everything is a thin wrapper over native inputs so the editor
 * stays light and consistent with the rest of the app.
 *
 * Status atoms (`StatusDot`, `CloseIcon`, `DownloadIcon`) live here too so
 * the rest of the app can compose the same chrome used by
 * `EvaluationExportTaskToast` — that toast is the reference design language.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Status atoms (shared with EvaluationExportTaskToast / WizardTaskStatus /
// RunStatusIndicator / Stepper). 10px circle, no border, semantic palette
// borrowed from the toast.
// ---------------------------------------------------------------------------

export type StatusDotState = 'idle' | 'running' | 'success' | 'failed' | 'warning' | 'booted'

const STATUS_DOT_BG: Record<StatusDotState, string> = {
  idle:    'bg-zinc-400 dark:bg-zinc-500',
  running: 'bg-sky-500',
  success: 'bg-emerald-500',
  failed:  'bg-rose-500',
  warning: 'bg-amber-500',
  // Boot-only "services up" — teal, distinct from the sky running dot.
  booted:  'bg-cyan-500',
}

export function StatusDot({
  state,
  pulse,
  halo,
  className = '',
}: {
  state: StatusDotState
  /** Override default pulse animation on the dot. `running` pulses by
   *  default; pass `true` for transient action states. */
  pulse?: boolean
  /** Render an `animate-ping` ring around the dot. Used by row-level status
   *  indicators where the halo is a stronger "this is changing" cue than
   *  the dot's own pulse. */
  halo?: boolean
  className?: string
}) {
  // `booted` breathes slowly by default (alive but idle); `running` pulses.
  const shouldPulse = pulse ?? (state === 'running' || state === 'booted')
  const animCls = !shouldPulse ? '' : state === 'booted' ? 'cl-dot-breathe' : 'animate-pulse'
  const dotCls = `cl-status-dot ${STATUS_DOT_BG[state]} ${animCls}`.trim()
  if (!halo) {
    return <span aria-hidden="true" className={`${dotCls} ${className}`.trim()} />
  }
  return (
    <span aria-hidden="true" className={`relative inline-flex ${className}`.trim()}>
      <span
        className={`absolute inset-0 inline-flex animate-ping rounded-full ${STATUS_DOT_BG[state]} opacity-60`}
      />
      <span className={`relative ${dotCls}`} />
    </span>
  )
}

export function CloseIcon({ size = 13 }: { size?: number } = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

export function DownloadIcon({ size = 13 }: { size?: number } = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  )
}

const inputStyle: CSSProperties = {
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

/** A titled section as a discrete bordered card — a header band + a padded body
 *  — so multiple sections in a config tab read as distinct blocks instead of
 *  one continuous list (the old faint `SectionHeader` blurred them together).
 *  Wrap sibling Sections in a `flex flex-col gap-3 p-3` scroller. */
export function Section({
  title,
  right,
  children,
  bodyClassName = 'px-3.5 py-3',
}: {
  title: ReactNode
  /** Optional right-aligned header slot (e.g. an action button). */
  right?: ReactNode
  children: ReactNode
  /** Override the body padding/layout (e.g. a flex list). */
  bodyClassName?: string
}) {
  return (
    <section
      className="overflow-hidden rounded-lg"
      style={{ border: '1px solid var(--border-default)', background: 'var(--bg-elevated)' }}
    >
      <div
        className="flex items-center gap-2 px-3.5 py-2.5"
        style={{
          borderBottom: '1px solid var(--border-default)',
          background: 'color-mix(in srgb, var(--bg-selected) 45%, transparent)',
        }}
      >
        <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{title}</span>
        {right != null && <span className="ml-auto flex items-center">{right}</span>}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  )
}

export function IconButton({
  onClick,
  ariaLabel,
  title,
  children,
  variant = 'ghost',
  size = 'sm',
}: {
  onClick: () => void
  ariaLabel: string
  title?: string
  children: ReactNode
  variant?: 'ghost' | 'danger'
  size?: 'sm' | 'md'
}) {
  const sizeCls = size === 'md' ? 'h-7 w-7' : 'h-6 w-6'
  const restColor = variant === 'danger' ? 'var(--danger)' : 'var(--text-muted)'
  const hoverColor = variant === 'danger' ? 'var(--danger)' : 'var(--text-primary)'
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      onClick={onClick}
      className={`inline-flex ${sizeCls} shrink-0 items-center justify-center rounded-md transition-colors duration-150`}
      style={{ color: restColor }}
      onMouseEnter={(e) => { e.currentTarget.style.color = hoverColor }}
      onMouseLeave={(e) => { e.currentTarget.style.color = restColor }}
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

/** Close on Escape — the one behavior every dialog/panel in the app wants.
 *  Shared so it's implemented once instead of a fresh `keydown` effect per
 *  dialog (it had drifted to 6+ near-identical copies). Components that
 *  unmount on close (most dialogs) can omit `enabled`; components that stay
 *  mounted and toggle visibility internally (e.g. `Modal`) must pass their
 *  own `open` flag so the listener isn't live while hidden. */
export function useEscapeToClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, enabled])
}

export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  status,
  icon,
  description,
  meta,
  width = 480,
  role = 'dialog',
  ariaLabel,
  headerActions,
  footer,
  children,
}: {
  open: boolean
  onClose: () => void
  /** Sentence-case title shown as `text-sm font-semibold`. */
  title?: string
  /** Optional uppercase kicker (e.g. "Settings", "Feature configuration"). */
  eyebrow?: string
  /** Optional status dot shown to the left of the title. */
  status?: StatusDotState
  /** Optional glyph rendered in an accent tile left of the title block — for
   *  hero dialogs whose header is an identity, not just a label. */
  icon?: ReactNode
  /** Optional one-line purpose sentence under the title (sentence case). */
  description?: string
  /** Optional metadata content rendered as a 2-col grid under the title. */
  meta?: ReactNode
  width?: number
  /** ARIA role for the dialog surface — `alertdialog` for error/confirmation
   *  interruptions, `dialog` (default) otherwise. */
  role?: 'dialog' | 'alertdialog'
  /** Accessible name when `title` isn't descriptive enough on its own, or
   *  there's no visible title at all (the body renders its own heading). */
  ariaLabel?: string
  /** Extra header buttons rendered before the built-in Close button (e.g. a
   *  destructive delete action on a hero dialog). */
  headerActions?: ReactNode
  /** Rendered as a pinned footer strip below the scrollable body — use this
   *  instead of putting action buttons in `children` so they don't scroll
   *  away with tall content. */
  footer?: ReactNode
  children: ReactNode
}) {
  useEscapeToClose(onClose, open)
  if (!open) return null
  const hasHeader = Boolean(title || eyebrow || meta || status || icon || description)
  return (
    <div
      className="cl-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role={role}
        aria-label={ariaLabel ?? title}
        aria-modal="true"
        className="cl-modal relative flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-lg"
        style={{
          width,
          maxWidth: '94vw',
          background: 'var(--bg-elevated)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {hasHeader && (
          <header className="cl-dialog-header">
            {status && <StatusDot state={status} className="mt-1" />}
            {icon && (
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                style={{ background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}
              >
                {icon}
              </span>
            )}
            <div className="min-w-0 flex-1">
              {eyebrow && <div className="cl-kicker mb-1">{eyebrow}</div>}
              {title && (
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {title}
                </h2>
              )}
              {description && (
                <p className="mt-0.5 text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                  {description}
                </p>
              )}
              {meta && <div className="cl-meta-grid mt-1">{meta}</div>}
            </div>
            {headerActions}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="cl-icon-button h-7 w-7 shrink-0"
            >
              <CloseIcon size={14} />
            </button>
          </header>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {children}
        </div>
        {footer && (
          <div className="cl-panel-footer flex items-center justify-end gap-2 px-4 py-3">
            {footer}
          </div>
        )}
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
  confirmDisabled = false,
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
  confirmDisabled?: boolean
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      status={variant === 'danger' ? 'failed' : undefined}
      width={440}
    >
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
          className="cl-button rounded-md px-3 py-1 text-[11px] uppercase tracking-wider"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
          className="rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors"
          style={{
            color: variant === 'danger' ? '#fff' : 'var(--text-primary)',
            background: variant === 'danger' ? 'var(--danger)' : 'transparent',
            border: variant === 'danger'
              ? '1px solid var(--danger)'
              : '1px solid var(--border-default)',
            opacity: busy || confirmDisabled ? 0.45 : 1,
            cursor: busy || confirmDisabled ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? '…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

/** Right-anchored slide-out panel — the second dialog shape in the app,
 *  alongside `Modal`. Used for grouped/list surfaces (Runs, Services, Modified
 *  test files, the Flights picker) instead of a centered modal. Wraps the
 *  shared backdrop/section shell + `cl-dialog-header` chrome; each caller
 *  supplies its own header actions, body, and optional footer. */
export function SlideOverPanel({
  onClose,
  ariaLabel,
  width = 560,
  header,
  footer,
  portal = false,
  testId,
  children,
}: {
  onClose: () => void
  ariaLabel: string
  /** Panel width in px, clamped to the viewport via `calc(100vw - 3rem)`. */
  width?: number
  /** Rendered inside the shared `cl-dialog-header` row — title/subtitle plus
   *  any actions (a Close button is the caller's responsibility, same as before). */
  header: ReactNode
  /** Rendered as a bordered footer strip below the body, when present. */
  footer?: ReactNode
  /** Portal to `document.body` — needed when the panel is mounted somewhere
   *  `overflow: hidden` or transformed (e.g. inside the collapsing status bar). */
  portal?: boolean
  testId?: string
  children: ReactNode
}) {
  useEscapeToClose(onClose)
  const node = (
    <div className="fixed inset-0 z-[60] flex items-start justify-end bg-black/30 p-6" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={testId}
        className="flex max-h-[calc(100vh-3rem)] flex-col rounded-lg border shadow-2xl"
        style={{
          width: `min(${width}px, calc(100vw - 3rem))`,
          borderColor: 'var(--border-default)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cl-dialog-header">{header}</header>
        {children}
        {footer && (
          <footer
            className="border-t px-4 py-2.5 text-[10.5px]"
            style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}
          >
            {footer}
          </footer>
        )}
      </section>
    </div>
  )
  return portal && typeof document !== 'undefined' ? createPortal(node, document.body) : node
}

export function ChevronRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

// ─── Toast (R51) ────────────────────────────────────────────────────────────
// Minimal in-app notification for "a background thing needs you" moments —
// today: a flight parking on a checkpoint or pausing on a stage failure.
// Token-styled card stack, bottom-right, amber accent, auto-dismiss; clicking
// navigates (the caller supplies onClick) and dismisses. Deliberately NOT
// routed — transient by definition (cl_route-every-surface's cold-load test).

export interface ToastItem {
  id: string
  title: string
  body?: string
  /** Navigate to the thing that needs attention (also dismisses). */
  onClick?: () => void
  /** R68: a toast that demands input — it NEVER auto-dismisses (no timer) and
   *  reads slightly stronger (warning-tinted border + a "needs input" eyebrow).
   *  Non-sticky toasts keep the 8s auto-dismiss. */
  sticky?: boolean
}

const TOAST_MS = 8000

export function ToastHost({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  useEffect(() => {
    // Only non-sticky toasts get a dismiss timer; sticky ones stay until the
    // user acts on them.
    const timed = toasts.filter((t) => !t.sticky)
    if (timed.length === 0) return
    const timers = timed.map((t) => setTimeout(() => onDismiss(t.id), TOAST_MS))
    return () => timers.forEach(clearTimeout)
    // Re-arm only when the set of (non-sticky) ids changes, not on parent
    // re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toasts.map((t) => `${t.id}:${t.sticky ? 1 : 0}`).join(',')])

  if (toasts.length === 0) return null
  // z-[90] sits above PortifyWizard (z-[80]) and LogCleanup/McpPromo (z-[70])
  // so an attention toast is never buried under an open workflow surface.
  return (
    <div className="fixed bottom-4 right-4 z-[90] flex w-80 flex-col gap-2" data-testid="toast-host">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          data-testid={`toast-${t.id}`}
          data-sticky={t.sticky ? 'true' : undefined}
          className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-lg transition-opacity"
          style={{
            background: 'var(--bg-surface)',
            // Sticky toasts wear a fuller warning border; informational toasts
            // keep the subtler blend.
            borderColor: t.sticky
              ? 'var(--warning)'
              : 'color-mix(in srgb, var(--warning) 45%, var(--border-default))',
          }}
          onClick={() => {
            t.onClick?.()
            onDismiss(t.id)
          }}
        >
          <span
            aria-hidden="true"
            className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
            style={{ background: 'var(--warning)' }}
          />
          <div className="min-w-0 flex-1">
            {t.sticky && (
              <div
                className="mb-0.5 text-[9px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--warning)' }}
              >
                Needs input
              </div>
            )}
            <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{t.title}</div>
            {t.body && <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t.body}</div>}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            className="cl-icon-button h-5 w-5 shrink-0 text-[11px]"
            onClick={(e) => {
              e.stopPropagation()
              onDismiss(t.id)
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
