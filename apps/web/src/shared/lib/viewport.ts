export type ViewportAlign = 'start' | 'center' | 'end'

/** The left edge, in px, for a `width`-wide floating surface (menu, popover,
 *  tooltip) placed against the horizontal span `anchor`: its left edge on the
 *  anchor's (`start`), centred on it (`center`), or its right edge on the
 *  anchor's (`end`) — then nudged so it keeps `edge` px clear of both viewport
 *  sides. When the viewport is too narrow for both margins the left one wins,
 *  so the start of the content stays on screen. */
export function clampToViewport(
  anchor: { left: number; right: number },
  width: number,
  align: ViewportAlign,
  viewportWidth: number,
  edge = 8,
): number {
  const preferred = align === 'start' ? anchor.left
    : align === 'end' ? anchor.right - width
      : (anchor.left + anchor.right) / 2 - width / 2
  return Math.max(edge, Math.min(preferred, viewportWidth - width - edge))
}
