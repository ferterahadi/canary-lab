/**
 * The run-detail tab frame.
 *
 * The pane carries no title of its own — the tab the user just clicked already
 * names it, and repeating "Journal" under a highlighted `Journal` tab is a line
 * of chrome that says nothing. What the frame does own is the sub-navigation
 * rail: Services (one tab per service) and Playwright (Terminal / Playback) are
 * the only panes with a second level, and their strip is styled as the primary
 * tab row is — same 12.5px `.cl-tab` face, same `gap-5` rhythm, same left edge —
 * so a sub-tab reads as a tab and not as a row of chips.
 */
import type { ReactNode } from 'react'

export const RUN_PANE_BAR_HEIGHT = 'h-9'

/** Sub-navigation rail. Geometry mirrors the run header's `<nav>`: `px-4` left
 *  edge, `gap-5` between tabs, underline flush with the rail's bottom border. */
export function RunPaneBar({ children }: { children: ReactNode }) {
  return (
    <div className={`cl-panel-header flex ${RUN_PANE_BAR_HEIGHT} shrink-0 items-end gap-5 overflow-x-auto px-4 scrollbar-none`}>
      {children}
    </div>
  )
}

export function RunPane({
  bar,
  scroll = true,
  padded = false,
  children,
}: {
  /** Sub-tabs for the panes that have them; omitted everywhere else. */
  bar?: ReactNode
  /** `false` for panes that own their own scroller (xterm, agent timeline). */
  scroll?: boolean
  /** Adds the standard 16px content inset. Off for full-bleed panes. */
  padded?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {bar && <RunPaneBar>{bar}</RunPaneBar>}
      <div
        className={`min-h-0 flex-1 ${scroll ? 'overflow-y-auto scrollbar-thin' : 'overflow-hidden'} ${padded ? 'p-4' : ''}`}
        // A pane whose content grows past the fold must not shove its own text
        // sideways when the scrollbar appears.
        style={scroll ? { scrollbarGutter: 'stable' } : undefined}
      >
        {children}
      </div>
    </div>
  )
}
