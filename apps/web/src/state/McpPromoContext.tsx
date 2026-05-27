import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type McpPromoAction = 'create-feature' | 'run-test' | 'export-evaluation'

interface PendingPromo {
  action: McpPromoAction
  continueAction: () => void
}

interface McpPromoContextValue {
  gatePromo: (action: McpPromoAction, continueAction: () => void) => void
}

const PROMO_VERSION = 'v1.1.0'
const VIDEO_SRC = '/promo/canary-lab-v1-1-mcp.webm'

const McpPromoContext = createContext<McpPromoContextValue | null>(null)

export function mcpPromoStorageKey(action: McpPromoAction): string {
  return `canary-lab.mcp-promo.${PROMO_VERSION}.dismissed.${action}`
}

export function McpPromoProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingPromo | null>(null)

  const gatePromo = useCallback((action: McpPromoAction, continueAction: () => void): void => {
    if (isDismissed(action)) {
      continueAction()
      return
    }
    setPending({ action, continueAction })
  }, [])

  const close = useCallback((): void => {
    setPending(null)
  }, [])

  const continuePending = useCallback((dismiss: boolean): void => {
    /* v8 ignore next -- this callback is only wired while a pending promo dialog is mounted. */
    if (!pending) return
    if (dismiss) markDismissed(pending.action)
    const action = pending.continueAction
    setPending(null)
    action()
  }, [pending])

  const value = useMemo<McpPromoContextValue>(() => ({ gatePromo }), [gatePromo])

  return (
    <McpPromoContext.Provider value={value}>
      {children}
      {pending && (
        <McpPromoDialog
          action={pending.action}
          videoSrc={VIDEO_SRC}
          onCancel={close}
          onContinue={continuePending}
        />
      )}
    </McpPromoContext.Provider>
  )
}

export function useMcpPromo(): McpPromoContextValue {
  const value = useContext(McpPromoContext)
  if (!value) throw new Error('useMcpPromo must be used inside McpPromoProvider')
  return value
}

function isDismissed(action: McpPromoAction): boolean {
  try {
    return window.localStorage.getItem(mcpPromoStorageKey(action)) === 'true'
  } catch {
    return false
  }
}

function markDismissed(action: McpPromoAction): void {
  try {
    window.localStorage.setItem(mcpPromoStorageKey(action), 'true')
  } catch {
    // Storage is only a convenience; the current click should still continue.
  }
}

function McpPromoDialog({
  action,
  videoSrc,
  onCancel,
  onContinue,
}: {
  action: McpPromoAction
  videoSrc: string
  onCancel: () => void
  onContinue: (dismiss: boolean) => void
}) {
  const [dismiss, setDismiss] = useState(false)
  const copy = PROMO_COPY[action]

  return (
    <div className="cl-modal-backdrop cl-mcp-promo-backdrop fixed inset-0 z-[70] flex items-center justify-center">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Canary Lab agent workflow"
        className="cl-modal cl-mcp-promo-modal overflow-hidden"
      >
        <button
          type="button"
          onClick={onCancel}
          aria-label="Not now"
          className="cl-mcp-promo-close"
        >
          X
        </button>
        <div className="cl-mcp-promo-video-wrap">
          <video
            src={videoSrc}
            autoPlay
            muted
            loop
            playsInline
            controls
            className="cl-mcp-promo-video"
          />
        </div>
        <div className="cl-mcp-promo-body">
          <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)' }}>
            <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{copy.label}</p>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-primary)' }}>{copy.example}</p>
          </div>
          <div className="cl-mcp-promo-footer">
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={dismiss}
                onChange={(event) => setDismiss(event.currentTarget.checked)}
                className="h-3.5 w-3.5"
              />
              Don't show this again
            </label>
            <button type="button" onClick={() => onContinue(dismiss)} className="cl-button-primary px-3 py-1.5">
              Continue
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

const PROMO_COPY: Record<McpPromoAction, { label: string; example: string }> = {
  'create-feature': {
    label: 'Feature test',
    example: '/canary-lab create a checkout test for the new voucher flow',
  },
  'run-test': {
    label: 'Run test cases',
    example: '/canary-lab run this feature against production',
  },
  'export-evaluation': {
    label: 'Export evaluation',
    example: '/canary-lab export the selected evaluation',
  },
}
