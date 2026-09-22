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
import { useEffect } from 'react'
import { CloseIcon } from './Icons'

// ─── Toast (R51) ────────────────────────────────────────────────────────────
// Minimal in-app notification for transient attention and completion moments.
// The caller chooses a status tone and either makes the whole toast actionable
// or requires its explicit action button. Deliberately NOT routed — transient
// by definition (cl_route-every-surface's cold-load test).

export interface ToastItem {
  id: string
  title: string
  body?: string
  /** Open or perform the toast's action (also dismisses by default). */
  onClick?: () => void
  /** R68: a toast that demands input — it NEVER auto-dismisses (no timer) and
   *  reads slightly stronger (warning-tinted border + a "needs input" eyebrow).
   *  Non-sticky toasts keep the 8s auto-dismiss. */
  sticky?: boolean
  /** Durable notifications are read on open, and deleted only by dismissal. */
  dismissOnOpen?: boolean
  actionLabel?: string
  dismissLabel?: string
  /** Status hue; warning remains the default for existing attention toasts. */
  tone?: 'warning' | 'success'
  /** Keep the card inert so only its labelled action can invoke `onClick`. */
  actionOnly?: boolean
}

export const TOAST_MS = 8000

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
  // z-[90] sits above routed dialogs and LogCleanup/McpPromo (z-[70])
  // so an attention toast is never buried under an open workflow surface.
  return (
    <div className="fixed bottom-4 right-4 z-[90] flex w-80 flex-col gap-2" data-testid="toast-host">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          data-testid={`toast-${t.id}`}
          data-sticky={t.sticky ? 'true' : undefined}
          className={`flex ${t.actionOnly ? '' : 'cursor-pointer'} items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-lg transition-opacity`}
          style={{
            background: 'var(--bg-surface)',
            // Sticky toasts wear a fuller warning border; informational toasts
            // keep the subtler blend.
            borderColor: t.tone === 'success' ? 'var(--success)' : t.sticky
              ? 'var(--warning)'
              : 'color-mix(in srgb, var(--warning) 45%, var(--border-default))',
          }}
          onClick={() => {
            if (t.actionOnly) return
            t.onClick?.()
            if (t.dismissOnOpen !== false) onDismiss(t.id)
          }}
        >
          <span
            aria-hidden="true"
            className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
            style={{ background: t.tone === 'success' ? 'var(--success)' : 'var(--warning)' }}
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
            {t.actionLabel && <button type="button" className={`${t.tone === 'success' ? 'cl-button-primary' : 'cl-button'} mt-1 px-2 py-1 text-xs`} onClick={(event) => {
              if (!t.actionOnly) return
              event.stopPropagation()
              if (t.dismissOnOpen !== false) onDismiss(t.id)
              t.onClick?.()
            }}>{t.actionLabel}</button>}
          </div>
          <button
            type="button"
            aria-label={t.dismissLabel ?? 'Dismiss'}
            className="cl-icon-button h-5 w-5 shrink-0 text-[11px]"
            onClick={(e) => {
              e.stopPropagation()
              onDismiss(t.id)
            }}
          >
            <CloseIcon size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}
