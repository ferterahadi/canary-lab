import type { CSSProperties, ReactNode } from 'react'

// The one stage-panel card chrome. Every block inside a flight stage pane — the
// repo-scan cards, the Service/Playwright digests, the requirement docs, the
// at-a-glance facts — is this surface: a bordered `--bg-surface` slab with an
// uppercase muted kicker naming what it holds. Kept in one home so a stage pane
// reads as one stack of like things instead of a pile of near-identical
// hand-rolled boxes (the sixth copy was the point where this became a primitive).

export const PANEL_CARD_CLASS = 'w-full rounded-lg border px-3 py-2.5'
export const PANEL_CARD_STYLE: CSSProperties = {
  borderColor: 'var(--border-default)',
  background: 'var(--bg-surface)',
  boxShadow: 'var(--shadow-panel)',
}

/** A card that needs the user — a checkpoint's question, a stage error, a
 *  robustness finding — is the same slab in a louder tone, not a differently
 *  shaped one. Four such cards each hand-rolled `p-3` (12px all round) beside
 *  PanelCard's `px-3 py-2.5`, so the one card the user MUST read sat 2px
 *  taller than every card around it. `warning` keeps the plain surface (the
 *  border alone asks the question); `danger` earns the tint. */
export type PanelCardTone = 'default' | 'warning' | 'danger'

// `default` adds nothing: PANEL_CARD_STYLE's inline border/background already
// win over any utility, so a class here would be dead weight.
const PANEL_CARD_TONE: Record<PanelCardTone, string> = {
  default: '',
  warning: 'border-warning/45',
  danger: 'border-danger/45 bg-danger/6',
}

/** Chrome for a toned card. `default` keeps the token style object (the shadow
 *  and surface come from PANEL_CARD_STYLE); a toned card states its border and
 *  background as token utilities, so only the shadow carries over. */
export function panelCardClass(tone: PanelCardTone = 'default'): string {
  return `${PANEL_CARD_CLASS} ${PANEL_CARD_TONE[tone]}`.trimEnd()
}

export function panelCardStyle(tone: PanelCardTone = 'default'): CSSProperties {
  return tone === 'default'
    ? PANEL_CARD_STYLE
    : { boxShadow: 'var(--shadow-panel)', ...(tone === 'warning' ? { background: 'var(--bg-surface)' } : {}) }
}
// The card's label voice is the system rubric (mono 10px caps, styles.css) so
// stage cards and workspace sub-captions read as one register.
export const PANEL_KICKER_CLASS = 'cl-rubric'

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
          {/* `.cl-rubric` already carries the muted colour — no inline twin. */}
          <div className={`min-w-0 truncate ${PANEL_KICKER_CLASS}`}>{kicker}</div>
          {aside && <><div className="flex-1" />{aside}</>}
        </div>
      )}
      {children}
    </div>
  )
}
