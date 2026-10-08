import { useEffect, useRef, useState } from 'react'
import { usePopoverDismiss } from '@/shared/ui/Overlays'
import { createPortal } from 'react-dom'
import { useTokenPickerOptions } from './use-token-picker-options'
import type { TokenNamespace } from './TemplatedInput'

/** Reserved first segment of the per-run port namespace (`${port.api}`). */
export const PORT_NS = 'port'

export interface PickerState {
  caret: { top: number; left: number }
  // When set, the picker replaces this existing pill instead of inserting at caret.
  replacingPill: HTMLElement | null
  initialSlot?: string
  initialKey?: string
}

// ─── picker ───────────────────────────────────────────────────────────────

export function TokenPicker({
  feature,
  state,
  namespaces,
  onClose,
  onPick,
}: {
  feature: string
  state: PickerState
  namespaces: TokenNamespace[]
  onClose: () => void
  onPick: (slot: string, key: string) => void
}) {
  const wantEnvset = namespaces.includes('envset')
  const wantPort = namespaces.includes('port')
  // A `${port.x}` pill reopens at the top level — port picks are one click,
  // there is no key sub-list to descend into.
  const [slot, setSlot] = useState<string | null>(
    state.initialSlot && state.initialSlot !== PORT_NS ? state.initialSlot : null,
  )
  const options = useTokenPickerOptions({ feature, wantEnvset, wantPort, slot })
  const { keys, portSlots, slots, error } = options
  const popRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (slot && options.slotRemoved) setSlot(null)
  }, [slot, options.slotRemoved])

  usePopoverDismiss(onClose, true, [popRef])

  return createPortal(
    <div
      ref={popRef}
      className="cl-popover fixed z-50 w-64 rounded-md p-2"
      style={{
        top: state.caret.top,
        left: state.caret.left,
      }}
    >
      <div className="mb-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {slot ? `Pick a key from ${slot}` : wantEnvset && wantPort ? 'Pick a token' : wantPort ? 'Pick a port slot' : 'Pick a slot'}
      </div>
      {error && <div className="mb-1 text-[11px]" style={{ color: 'var(--danger)' }}>{error} <button type="button" className="cl-button px-2" onClick={options.retry}>Retry</button></div>}
      {slot && (
          <button
            type="button"
            onClick={() => setSlot(null)}
            className="mb-1 text-[10px] uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            ← Back
          </button>
      )}
      {!slot ? (
        <>
          {wantPort && (
            <div className={wantEnvset ? 'mb-1.5' : undefined}>
              {wantEnvset && (
                <div className="mb-0.5 text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)', opacity: 0.8 }}>
                  Port slots · injected per run
                </div>
              )}
              {portSlots === null ? (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Loading…</div>
              ) : portSlots.length === 0 ? (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  No port slots declared. Declare them in the Ports tab (or run Portify).
                </div>
              ) : (
                <div className="max-h-40 overflow-y-auto scrollbar-thin">
                  {portSlots.map((p) => (
                    <button
                      key={p}
                      type="button"
                      disabled={!options.portsConfirmed}
                      onClick={() => { if (options.portsConfirmed) onPick(PORT_NS, p) }}
                      className="block w-full truncate rounded px-2 py-1 text-left text-[11px] hover:opacity-80"
                      style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
                    >
                      {`\${port.${p}}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {wantEnvset && (
            <>
              {wantPort && (
                <div className="mb-0.5 text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)', opacity: 0.8 }}>
                  Envset slots · values from env files
                </div>
              )}
              {slots.length === 0 ? (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  No slots in this suite. Add one in the Envsets tab.
                </div>
              ) : (
                <div className="max-h-60 overflow-y-auto scrollbar-thin">
                  {slots.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={!options.indexConfirmed}
                      onClick={() => { if (options.indexConfirmed) setSlot(s) }}
                      className="block w-full truncate rounded px-2 py-1 text-left text-[11px] hover:opacity-80"
                      style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      ) : keys === null ? (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Loading…</div>
      ) : keys.length === 0 ? (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Slot has no keys yet. Add some in the Envsets tab.
        </div>
      ) : (
        <>
          <div className="max-h-60 overflow-y-auto scrollbar-thin">
            {keys.map((k) => (
              <button
                key={k}
                type="button"
                disabled={!options.keysConfirmed}
                onClick={() => { if (options.keysConfirmed) onPick(slot, k) }}
                className="block w-full truncate rounded px-2 py-1 text-left text-[11px] hover:opacity-80"
                style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
              >
                {k}
              </button>
            ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
