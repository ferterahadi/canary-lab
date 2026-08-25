/** Driving a stage's Activity band from a test.
 *
 *  The band has no Hide/Show button (R88): its label bar IS the panel's movable
 *  top edge, and folding it away is the bottom end of that same drag. So there
 *  is no `.click()` to make and no `aria-expanded` to read — the bar is a
 *  `separator`, and folded reads as `aria-valuenow="0"`.
 *
 *  Every flight test goes through these three helpers rather than inventing its
 *  own double-click, so changing the gesture is one edit here instead of four
 *  files that each half-remember it. */
export function activityBar(container: ParentNode): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="stage-activity-resize"]')
}

export function isActivityOpen(container: ParentNode): boolean {
  const bar = activityBar(container)
  return bar != null && bar.getAttribute('aria-valuenow') !== '0'
}

/** Double-click the bar — the pointer shortcut for the fold, and the closest
 *  thing to the single click the old button took. */
export function toggleActivity(container: ParentNode): void {
  activityBar(container)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
}
