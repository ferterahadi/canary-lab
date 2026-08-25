import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as api from '@/shared/api/client'
import type { ExecutionType } from '@/shared/api/types'
import { type RunViewModel } from '../utils/run-view-model'
import { RunStatusIndicator } from './RunStatusIndicator'

// Returns viewport-relative coords for a popover anchored to the right edge
// of the given element. Recomputes on scroll/resize while the popover is
// open, so the menu stays attached as the user scrolls within column 3.
export function useAnchoredPosition(
  anchorRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const compute = (): void => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      // Right-align: align the popover's right edge with the anchor's right edge.
      let left = r.right - width
      if (left < 8) left = 8
      const maxLeft = window.innerWidth - width - 8
      if (left > maxLeft) left = maxLeft
      setPos({ top: r.bottom + 6, left })
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [open, anchorRef, width])
  return pos
}

export function RunActionsKebab({
  view,
  displayStatus,
  executionType,
  open,
  onOpenToggle,
  onClose,
  isStopping,
  isPausing,
  isCancellingHeal,
  onStop,
  onPause,
  onCancelHeal,
}: {
  view: RunViewModel
  displayStatus: import('@/shared/api/types').DisplayStatus
  executionType?: import('@/shared/api/types').ExecutionType
  open: boolean
  onOpenToggle: (e: React.MouseEvent) => void
  onClose: () => void
  isStopping: boolean
  isPausing: boolean
  isCancellingHeal: boolean
  onStop: () => void
  onPause: () => void
  onCancelHeal: () => void
}) {
  const stopAvailable = view.actions.stop.enabled
  const pauseAvailable = view.actions.pauseHeal.enabled
  const cancelHealAvailable = view.actions.cancelHeal.enabled
  // NOTE: Delete is intentionally NOT in this menu; it's rendered as a
  // dedicated icon button next to the status indicator at all viewport
  // widths. Keeping it out of the kebab is what guarantees the user sees
  // Delete on the right of the status, regardless of compact mode.
  const hasActions = stopAvailable || pauseAvailable || cancelHealAvailable
  const POPOVER_WIDTH = 180
  const buttonRef = useRef<HTMLButtonElement>(null)
  const pos = useAnchoredPosition(buttonRef, open && hasActions, POPOVER_WIDTH)
  return (
    <div className="shrink-0" data-run-menu>
      <div className="flex items-center gap-1.5">
        <RunStatusIndicator status={displayStatus} executionType={executionType} />
        {hasActions && (
          <button
            ref={buttonRef}
            type="button"
            onClick={onOpenToggle}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Run actions"
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150"
            style={{
              border: '1px solid var(--border-default)',
              background: open ? 'var(--bg-elevated)' : 'transparent',
              color: 'var(--text-secondary)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="8" r="1.4" />
              <circle cx="8" cy="8" r="1.4" />
              <circle cx="13" cy="8" r="1.4" />
            </svg>
          </button>
        )}
      </div>
      {open && hasActions && pos && createPortal(
        <div
          role="menu"
          data-run-menu
          onClick={(e) => e.stopPropagation()}
          className="cl-popover overflow-hidden rounded-lg py-1 text-xs"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: POPOVER_WIDTH,
            zIndex: 1000,
          }}
        >
          {stopAvailable && (
            <MenuItem
              label={isStopping ? 'Stopping...' : 'Stop'}
              variant="danger"
              disabled={isStopping}
              icon={(
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="10" height="10" rx="1.5" />
                </svg>
              )}
              onClick={() => { onStop(); onClose() }}
            />
          )}
          {pauseAvailable && (
            <MenuItem
              label={isPausing ? 'Pausing...' : 'Pause & Heal'}
              variant="warning"
              disabled={isPausing}
              icon={(
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="3" height="10" rx="1" />
                  <rect x="10" y="3" width="3" height="10" rx="1" />
                </svg>
              )}
              onClick={() => { onPause(); onClose() }}
            />
          )}
          {cancelHealAvailable && (
            <MenuItem
              label={isCancellingHeal ? 'Cancelling...' : 'Stop Heal'}
              variant="danger"
              disabled={isCancellingHeal}
              icon={(
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="3" y="3" width="10" height="10" rx="1.5" />
                </svg>
              )}
              onClick={() => { onCancelHeal(); onClose() }}
            />
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

export function MenuItem({
  label,
  variant,
  disabled,
  icon,
  onClick,
}: {
  label: string
  variant: 'warning' | 'danger'
  disabled: boolean
  icon?: React.ReactNode
  onClick: () => void
}) {
  const color = variant === 'danger'
    ? 'text-danger hover:bg-danger/8 dark:hover:bg-danger/10'
    : 'text-warning hover:bg-warning/8 dark:hover:bg-warning/10'
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick() }}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left font-medium transition-colors duration-100 ${color} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span>{label}</span>
    </button>
  )
}

export function ExecutionTypeBadge({ type }: { type: ExecutionType }) {
  const style = type === 'verify'
    ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
    : type === 'boot'
      ? { background: 'var(--boot-soft)', color: 'var(--boot)' }
      : type === 'benchmark'
        ? { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' }
        : { background: 'var(--bg-selected)', color: 'var(--text-muted)' }
  const label = type === 'verify' ? 'Verify' : type === 'boot' ? 'Boot' : type === 'benchmark' ? 'Arm' : 'Run'
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
      style={{ ...style, letterSpacing: '0.04em' }}
    >
      {label}
    </span>
  )
}

// Ghost icon-button. Stays calm at rest (no border, no fill); hover reveals
// a tinted fill so the affordance is clear. The leading icon disambiguates
// from the bare-text status indicator next to it.
//
// Rendered as `<span role="button">` because the parent row is itself a
// `<button>` and HTML disallows nesting.
export function ActionButton({
  label,
  icon,
  disabled,
  variant,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  disabled: boolean
  variant: 'warning' | 'danger'
  onClick: (e: React.MouseEvent) => void
}) {
  const tone = variant === 'danger'
    ? 'text-danger/80 hover:bg-danger/12 hover:text-danger'
    : 'text-warning/80 hover:bg-warning/15 hover:text-warning'
  return (
    <span
      role="button"
      tabIndex={0}
      aria-disabled={disabled}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClick(e as unknown as React.MouseEvent) }
      }}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wide transition-colors duration-150 ${tone} ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
    >
      <span aria-hidden="true" className="inline-flex h-3 w-3 items-center justify-center">{icon}</span>
      {label}
    </span>
  )
}

// Icon-only ghost trash button. Square hover surface (16×16 visual / 20×20
// hit area) keeps the row dense; hover reveals a soft rose fill so the
// affordance is unmistakable. When `disabled`, it shows at low opacity with
// a tooltip explaining why — the user always sees that delete *exists*,
// just not whether it's currently available. Rendered as `<span role="button">`
// because the surrounding row is itself a `<button>`.
// Sibling of DeleteIconButton — same 20×20 ghost-button silhouette, same
// 11px SVG, but blue-tinted to read as "retry" instead of "destroy". Only
// rendered when restart is available (terminal failed/aborted), so its mere
// presence is the affordance — no "Retest" label needed in the row body.
// While spinning, the icon rotates and the button is disabled to swallow
// double-clicks; the WS update flips the row's status badge to running/
// healing within a beat or two, which removes the icon entirely.
export function RetestIconButton({
  disabled,
  spinning,
  onClick,
}: {
  disabled: boolean
  spinning: boolean
  onClick: (e: React.MouseEvent) => void
}) {
  const label = spinning
    ? 'Retesting remaining tests…'
    : 'Retest remaining: reruns failed, skipped, and pending tests'
  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={label}
      title={label}
      onClick={(e) => {
        if (disabled) { e.stopPropagation(); return }
        onClick(e)
      }}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); e.stopPropagation()
          onClick(e as unknown as React.MouseEvent)
        }
      }}
      className={`inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors duration-150 ${
        spinning
          ? 'cursor-wait text-accent/70'
          : 'cursor-pointer text-accent/70 hover:bg-accent/12 hover:text-accent'
      }`}
    >
      <svg
        viewBox="0 0 16 16"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={spinning ? 'animate-spin' : ''}
      >
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
        <path d="M13.5 2v3.5H10" />
      </svg>
    </span>
  )
}

export function DeleteIconButton({
  disabled,
  disabledReason,
  onClick,
}: {
  disabled: boolean
  disabledReason?: string
  onClick: (e: React.MouseEvent) => void
}) {
  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={disabled ? (disabledReason ?? 'Delete unavailable') : 'Delete run'}
      title={disabled ? (disabledReason ?? 'Delete unavailable') : 'Delete run'}
      onClick={(e) => {
        if (disabled) { e.stopPropagation(); return }
        onClick(e)
      }}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); e.stopPropagation()
          onClick(e as unknown as React.MouseEvent)
        }
      }}
      className={`ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors duration-150 ${
        disabled
          ? 'cursor-not-allowed text-idle/50'
          : 'cursor-pointer text-danger/70 hover:bg-danger/12 hover:text-danger'
      }`}
    >
      <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
        <path d="M5.5 2h5l.5 1H14v1H2V3h3l.5-1zM3.5 5h9l-.7 8.2a1.5 1.5 0 0 1-1.5 1.3H5.7a1.5 1.5 0 0 1-1.5-1.3L3.5 5zm2.5 2v6h1V7H6zm3 0v6h1V7H9z" />
      </svg>
    </span>
  )
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  variant,
  onCancel,
  onConfirm,
}: {
  title: string
  description: string
  confirmLabel: string
  variant: 'warning' | 'danger'
  onCancel: () => void
  onConfirm: () => void
}) {
  const isDanger = variant === 'danger'
  const confirmStyle: React.CSSProperties = isDanger
    ? { background: 'var(--danger)', borderColor: 'var(--danger)' }
    : { background: 'var(--warning)', borderColor: 'var(--warning)' }
  return (
    <div className="cl-modal-backdrop absolute inset-0 z-50 flex items-center justify-center p-6">
      <div className="cl-modal w-[440px] p-5">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
        <p
          className="mt-1.5 text-[13px] leading-relaxed"
          style={{ color: 'var(--text-secondary)' }}
        >
          {description}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="cl-button px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="cl-button-primary px-3 py-1.5"
            style={confirmStyle}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
