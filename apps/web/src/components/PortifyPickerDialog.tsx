import { useEffect, useMemo, useState } from 'react'
import type { Feature } from '../api/types'

interface Props {
  features: Feature[]
  /** Start (or reopen the Plan screen of) port-ification for this feature. */
  onPick: (feature: string) => void
  onClose: () => void
}

// Feature picker for the always-on Portify launcher. Lists every feature with
// its portified status so the user can pick one to make its ports injectable.
// Selecting a feature opens the Portify wizard's Plan screen for it.
export function PortifyPickerDialog({ features, onPick, onClose }: Props) {
  const [query, setQuery] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? features.filter((f) => f.name.toLowerCase().includes(q)) : features
    // Surface not-yet-portified features first — they're the actionable ones.
    return [...list].sort((a, b) => Number(Boolean(a.portified)) - Number(Boolean(b.portified)) || a.name.localeCompare(b.name))
  }, [features, query])

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-end bg-black/30 p-6" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Portify a feature"
        className="flex max-h-[calc(100vh-3rem)] w-[min(520px,calc(100vw-3rem))] flex-col rounded-lg border shadow-2xl"
        style={{ borderColor: 'var(--border-default)', background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cl-dialog-header">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">🔌 Portify a feature</h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Make a feature's ports injectable so it can boot concurrently — saved as an ephemeral overlay, the product repo is never modified.
            </p>
          </div>
          <button type="button" aria-label="Close Portify picker" onClick={onClose} className="rounded px-2 py-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            Close
          </button>
        </header>

        {features.length > 8 && (
          <div className="border-b px-3 py-2" style={{ borderColor: 'var(--border-default)' }}>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter features…"
              className="w-full rounded-md px-2.5 py-1.5 text-xs outline-none"
              style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
            />
          </div>
        )}

        {features.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
            No features detected.
          </div>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2 scrollbar-thin">
            {filtered.map((f) => (
              <li key={f.name}>
                <button
                  type="button"
                  onClick={() => { onPick(f.name); onClose() }}
                  className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
                  style={{ border: '1px solid var(--border-default)' }}
                  title={f.portified ? `Re-run Portify on ${f.name}` : `Portify ${f.name}`}
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{f.name}</span>
                  {f.portified ? (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide"
                      style={{
                        color: 'rgb(52,211,153)',
                        background: 'color-mix(in srgb, rgb(52,211,153) 14%, transparent)',
                        border: '1px solid color-mix(in srgb, rgb(52,211,153) 35%, transparent)',
                      }}
                    >
                      ⇄ portified
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>not portified</span>
                  )}
                  <span aria-hidden="true" className="shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    {f.portified ? '↻' : '→'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <footer className="border-t px-4 py-2.5 text-[10.5px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
          One workflow runs at a time. Already-portified features can be re-run to refresh the overlay.
        </footer>
      </section>
    </div>
  )
}
