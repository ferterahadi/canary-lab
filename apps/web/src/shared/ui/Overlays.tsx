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
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { CloseIcon } from './Icons'
import { StatusDot, StatusDotState } from './atoms'

// Layered Escape: a single document listener dispatches Escape to only the
// innermost open layer (the most recently activated), so a dialog or menu
// opened over a page swallows the key instead of both closing on one press.
// Layers register in mount/activation order; the top of the stack wins, and
// once it pops the layer beneath takes over on the next press. Every hook user
// (Modal, the flight page, its header menus, …) shares this ONE stack, so
// there is never a duplicate `keydown` listener racing another.
export const escapeLayers: Array<() => void> = []

export let escapeListenerBound = false

export function dispatchEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  const top = escapeLayers[escapeLayers.length - 1]
  if (top) top()
}

export function pushEscapeLayer(handler: () => void): () => void {
  escapeLayers.push(handler)
  if (!escapeListenerBound) {
    document.addEventListener('keydown', dispatchEscape)
    escapeListenerBound = true
  }
  return () => {
    const i = escapeLayers.lastIndexOf(handler)
    if (i >= 0) escapeLayers.splice(i, 1)
    if (escapeLayers.length === 0 && escapeListenerBound) {
      document.removeEventListener('keydown', dispatchEscape)
      escapeListenerBound = false
    }
  }
}

/** Close on Escape — the one behavior every dialog/panel/menu in the app wants.
 *  Shared so it's implemented once instead of a fresh `keydown` effect per
 *  dialog (it had drifted to 6+ near-identical copies), AND so nested layers
 *  cooperate: the innermost open layer handles Escape and the ones beneath it
 *  stay put (a dialog over the flight page closes only the dialog, not both).
 *  The layer registers once while `enabled`, independent of `onClose`'s
 *  identity, so a re-render never reshuffles the stack; the latest `onClose` is
 *  always the one invoked. Components that unmount on close (most dialogs) can
 *  omit `enabled`; components that stay mounted and toggle visibility (e.g.
 *  `Modal`, a header dropdown) must pass their own `open` flag so their layer
 *  isn't live while hidden. */
export function useEscapeToClose(onClose: () => void, enabled = true): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!enabled) return
    return pushEscapeLayer(() => onCloseRef.current())
  }, [enabled])
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
  height,
  role = 'dialog',
  ariaLabel,
  testId,
  headerActions,
  subheader,
  footer,
  stableScrollGutter,
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
  /** Fixed height (e.g. `'88vh'` or a px number) instead of shrinking to fit
   *  content — for a multi-tab/paginated dialog whose body height should stay
   *  stable as the active section's content amount changes. Omit to shrink-
   *  wrap content up to the default `max-h-[calc(100vh-2rem)]` cap. */
  height?: number | string
  /** ARIA role for the dialog surface — `alertdialog` for error/confirmation
   *  interruptions, `dialog` (default) otherwise. */
  role?: 'dialog' | 'alertdialog'
  /** Accessible name when `title` isn't descriptive enough on its own, or
   *  there's no visible title at all (the body renders its own heading). */
  ariaLabel?: string
  /** `data-testid` on the dialog surface, so tests can assert open/closed. */
  testId?: string
  /** Extra header buttons rendered before the built-in Close button (e.g. a
   *  destructive delete action on a hero dialog). */
  headerActions?: ReactNode
  /** Rendered between the header and the scrollable body, outside the scroll
   *  area — e.g. a tab bar that should stay put while its section scrolls.
   *  When a caller's whole body already manages its own scroll region (a
   *  tabbed editor whose panels each own scrolling + a pinned save bar),
   *  put that body here instead of `children` — otherwise Modal's own
   *  scroll wrapper would double up with the panel's. */
  subheader?: ReactNode
  /** Rendered as a pinned footer strip below the scrollable body — use this
   *  instead of putting action buttons in `children` so they don't scroll
   *  away with tall content. */
  footer?: ReactNode
  /** Reserve the vertical scrollbar's gutter even when it isn't showing, so a
   *  body whose height changes with a toggle/disclosure (e.g. the flight
   *  launcher's collapsible step list) doesn't jump sideways as the scrollbar
   *  appears and disappears. */
  stableScrollGutter?: boolean
  children?: ReactNode
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
        data-testid={testId}
        className="cl-modal relative flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-lg"
        style={{
          width,
          maxWidth: '94vw',
          ...(height ? { height } : {}),
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
        {subheader}
        {children != null && (
          <div
            className="min-h-0 flex-1 overflow-y-auto scrollbar-thin"
            style={stableScrollGutter ? { scrollbarGutter: 'stable' } : undefined}
          >
            {children}
          </div>
        )}
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
            color: variant === 'danger' ? 'var(--on-accent)' : 'var(--text-primary)',
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
    <div className="fixed inset-0 z-[60] flex items-start justify-end p-6" style={{ background: 'var(--overlay-backdrop)' }} onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={testId}
        className="flex max-h-[calc(100vh-3rem)] flex-col rounded-lg border"
        style={{
          width: `min(${width}px, calc(100vw - 3rem))`,
          borderColor: 'var(--border-default)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
          boxShadow: 'var(--shadow-popover)',
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
