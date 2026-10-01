import { useEffect, useLayoutEffect } from 'react'

function subscribePosition(reposition: () => void): () => void {
  reposition()
  window.addEventListener('resize', reposition)
  window.addEventListener('scroll', reposition, true)
  return () => {
    window.removeEventListener('resize', reposition)
    window.removeEventListener('scroll', reposition, true)
  }
}

/** Keep a portaled popover pinned to its trigger while it is open: measure once
 *  on open, then again on every resize and every scroll. The scroll listener
 *  uses the capture phase because a scrolling ancestor of the trigger fires no
 *  scroll event on `window` itself, and the popover would drift off its anchor.
 *  `reposition` should be stable (a `useCallback`), or the listeners rebind on
 *  every render. */
export function useAnchoredPosition(
  open: boolean,
  reposition: () => void,
  timing: 'effect' | 'layout' = 'effect',
): void {
  // Coordinate-owning menus need their first position before paint. Existing
  // consumers retain passive effects; both modes share the subscription owner.
  useLayoutEffect(() => {
    if (open && timing === 'layout') return subscribePosition(reposition)
  }, [open, reposition, timing])
  useEffect(() => {
    if (open && timing === 'effect') return subscribePosition(reposition)
  }, [open, reposition, timing])
}
