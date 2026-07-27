import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as api from '@/shared/api/client'
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
  const [index, setIndex] = useState<api.EnvsetIndex | null>(null)
  // A `${port.x}` pill reopens at the top level — port picks are one click,
  // there is no key sub-list to descend into.
  const [slot, setSlot] = useState<string | null>(
    state.initialSlot && state.initialSlot !== PORT_NS ? state.initialSlot : null,
  )
  const [keys, setKeys] = useState<string[] | null>(null)
  const [portSlots, setPortSlots] = useState<string[] | null>(wantPort ? null : [])
  const [error, setError] = useState<string | null>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!wantEnvset) return
    api.getEnvsetsIndex(feature)
      .then(setIndex)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Load failed'))
  }, [feature, wantEnvset])

  useEffect(() => {
    if (!wantPort) return
    api.getFeatureConfigDoc(feature)
      .then((doc) => setPortSlots(extractPortSlots(doc)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Load failed'))
  }, [feature, wantPort])

  useEffect(() => {
    if (!slot || !index || index.envs.length === 0) return
    const env = index.envs[0].name
    api.getEnvsetSlot(feature, env, slot)
      .then((doc) => setKeys(doc.entries.map((e) => e.key)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Load failed'))
  }, [slot, index, feature])

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose])

  const slots = index?.envs[0]?.slots ?? []

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
      {error && <div className="mb-1 text-[11px]" style={{ color: 'var(--danger)' }}>{error}</div>}
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
                      onClick={() => onPick(PORT_NS, p)}
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
                  No slots in this feature. Add one in the Envsets tab.
                </div>
              ) : (
                <div className="max-h-60 overflow-y-auto scrollbar-thin">
                  {slots.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSlot(s)}
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
          <button
            type="button"
            onClick={() => { setSlot(null); setKeys(null) }}
            className="mb-1 text-[10px] uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            ← Back
          </button>
          <div className="max-h-60 overflow-y-auto scrollbar-thin">
            {keys.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => onPick(slot, k)}
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

/** Unique port-slot names declared across every start command in the feature
 *  config (duck-typed walk of the parsed doc — same shape PortsTab edits). */
export function extractPortSlots(doc: api.ParsedConfigDoc): string[] {
  const out: string[] = []
  const root = doc.parsed.value
  if (!root || typeof root !== 'object' || Array.isArray(root)) return out
  const repos = (root as Record<string, unknown>).repos
  if (!Array.isArray(repos)) return out
  for (const repo of repos) {
    if (!repo || typeof repo !== 'object') continue
    const commands = (repo as Record<string, unknown>).startCommands
    if (!Array.isArray(commands)) continue
    for (const cmd of commands) {
      if (!cmd || typeof cmd !== 'object') continue
      const ports = (cmd as Record<string, unknown>).ports
      if (!Array.isArray(ports)) continue
      for (const p of ports) {
        if (!p || typeof p !== 'object') continue
        const name = (p as Record<string, unknown>).name
        if (typeof name === 'string' && name.trim() && !out.includes(name)) out.push(name)
      }
    }
  }
  return out
}
