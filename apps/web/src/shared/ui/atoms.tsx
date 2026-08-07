import type { ReactNode } from 'react'

export { ComplexValueBadge, FieldRow, NumberInput, Segmented, Select, TextInput, Textarea, Toggle } from './FormFields'
export { ChevronRightIcon, CloseIcon, DownloadIcon, FolderIcon, HintIcon, MinusIcon, PlusIcon, TrashIcon } from './Icons'
export { ConfirmModal, Modal, SlideOverPanel, useEscapeToClose } from './Overlays'
export { ToastHost } from './Toasts'
export type { ToastItem } from './Toasts'

// ---------------------------------------------------------------------------
// Status atoms (shared with EvaluationExportTaskToast / WizardTaskStatus /
// RunStatusIndicator / Stepper). 10px circle, no border, semantic palette
// borrowed from the toast.
// ---------------------------------------------------------------------------

export type StatusDotState = 'idle' | 'running' | 'success' | 'failed' | 'warning' | 'booted'

const STATUS_DOT_BG: Record<StatusDotState, string> = {
  idle:    'bg-idle',
  running: 'bg-running',
  success: 'bg-success',
  failed:  'bg-danger',
  warning: 'bg-warning',
  // Boot-only "services up" — teal, distinct from the sky running dot.
  booted:  'bg-boot',
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
  headerPadding = 'default',
}: {
  title: ReactNode
  /** Optional right-aligned header slot (e.g. an action button). */
  right?: ReactNode
  children: ReactNode
  /** Override the body padding/layout (e.g. a flex list). */
  bodyClassName?: string
  /** A custom header may own its spacing, while ordinary section titles keep
   *  the shared inset rhythm. */
  headerPadding?: 'default' | 'none'
}) {
  return (
    <section
      className="overflow-hidden rounded-lg"
      style={{ border: '1px solid var(--border-default)', background: 'var(--bg-elevated)' }}
    >
      <div
        className={headerPadding === 'none' ? 'flex min-h-[39px] items-center gap-2' : 'flex items-center gap-2 px-3.5 py-2.5'}
        style={{
          borderBottom: '1px solid var(--border-default)',
          background: 'color-mix(in srgb, var(--bg-selected) 45%, transparent)',
          padding: headerPadding === 'none' ? 0 : undefined,
        }}
      >
        {/* `.cl-frame-heading` (12.5/600) — the named voice for a heading inside
            a framed section. The old ad-hoc 12px/500 was the app's ROW-label
            register, so a section title read smaller than the rows under it. */}
        <span className="cl-frame-heading">{title}</span>
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
