import type { CSSProperties, ReactNode } from 'react'

// The one stage-panel card chrome. Every block inside a flight stage pane — the
// repo-scan cards, the Service/Playwright digests, the requirement docs, the
// at-a-glance facts — is this surface: a bordered `--bg-surface` slab with an
// uppercase muted kicker naming what it holds. Kept in one home so a stage pane
// reads as one stack of like things instead of a pile of near-identical
// hand-rolled boxes (the sixth copy was the point where this became a primitive).

export const PANEL_CARD_CLASS = 'w-full rounded border px-3 py-2.5'
export const PANEL_CARD_STYLE: CSSProperties = {
  borderColor: 'var(--border-default)',
  background: 'var(--bg-surface)',
}
export const PANEL_KICKER_CLASS = 'text-[9.5px] font-semibold uppercase tracking-[0.11em]'

/** Card + kicker in one call, with an optional right-aligned `aside` (chips,
 *  status) on the kicker line. Callers needing bespoke header content compose
 *  the constants directly. */
export function PanelCard({ kicker, aside, testId, title, children }: {
  kicker?: string
  aside?: ReactNode
  testId?: string
  title?: string
  children: ReactNode
}) {
  return (
    <div data-testid={testId} title={title} className={PANEL_CARD_CLASS} style={PANEL_CARD_STYLE}>
      {(kicker || aside) && (
        <div className="mb-1.5 flex min-w-0 items-center gap-2">
          <div className={`min-w-0 truncate ${PANEL_KICKER_CLASS}`} style={{ color: 'var(--text-muted)' }}>{kicker}</div>
          {aside && <><div className="flex-1" />{aside}</>}
        </div>
      )}
      {children}
    </div>
  )
}
