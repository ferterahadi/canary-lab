import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { CopyField } from '@/shared/ui/CopyField'
import { Modal, Section } from '@/shared/ui/atoms'

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

  const value = useMemo<McpPromoContextValue>(() => ({ gatePromo }), [gatePromo])

  return (
    <McpPromoContext.Provider value={value}>
      {children}
      {pending && (
        <McpPromoDialog
          action={pending.action}
          videoSrc={VIDEO_SRC}
          onCancel={close}
          // Built inside the `pending &&` branch on purpose: TypeScript narrows
          // `pending` to non-null here, so the "no pending promo" state this
          // handler used to guard against is unrepresentable rather than an
          // untestable early return.
          onContinue={(dismiss) => {
            if (dismiss) markDismissed(pending.action)
            const action = pending.continueAction
            setPending(null)
            action()
          }}
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
  action: _action,
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

  // The shared `Modal` chrome, not a hand-rolled surface: this was the one
  // dialog in the app that built its own backdrop, header and close button, so
  // it carried a letter "X" where every other dialog shows `CloseIcon`, and a
  // ~70-line `cl-mcp-promo-*` skin free to drift from the dialog tokens. Only
  // the video frame needs CSS of its own now.
  return (
    <Modal
      open
      onClose={onCancel}
      eyebrow="Agents"
      title="Run Canary Lab from your agent"
      description="Claude and Codex drive the same runs, repairs and reports through Canary Lab's MCP tools."
      width={760}
      testId="mcp-promo"
      bodyClassName="min-h-0 flex-1 overflow-y-auto scrollbar-thin"
      footer={(
        <>
          {/* The 13px accent-tinted native mark the Getting Started dialog and
              every Project Settings choice row use — untinted it falls back to
              the browser's own blue, the one colour here that isn't ours. */}
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={dismiss}
              onChange={(event) => setDismiss(event.currentTarget.checked)}
              className="h-[13px] w-[13px] shrink-0"
              style={{ accentColor: 'var(--accent)' }}
            />
            Don&apos;t show this again
          </label>
          <button type="button" onClick={() => onContinue(dismiss)} className="cl-button-primary px-3 py-1.5">
            Continue
          </button>
        </>
      )}
    >
      <div className="cl-mcp-promo-frame">
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
      {/* A command the reader has to run is a `CopyField` everywhere else in the
          app (the Getting Started dialog's agent prompt, the connect steps) —
          it was prose with an inline `<code>` here, so the one actionable
          string in the dialog was the only one you had to retype. */}
      <div className="p-3">
        <Section title="One-time setup">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Run <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>npx canary-lab setup</code> once
            from this workspace, then restart Codex or Claude to load the tools.
          </p>
          <CopyField value="npx canary-lab setup" label="setup command" testId="mcp-promo-setup-command" />
        </Section>
      </div>
    </Modal>
  )
}
