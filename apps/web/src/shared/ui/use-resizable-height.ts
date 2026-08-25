import { useCallback, useEffect, useState } from 'react'

/** Drag-to-resize height for a panel that must NOT size to its content, where
 *  the SAME gesture also collapses it.
 *
 *  Sizing to content is wrong wherever the content grows without a ceiling — an
 *  agent timeline appends rows for as long as the agent runs, so a
 *  content-height panel would creep down the page mid-stream and move
 *  everything under it. The panel instead keeps a height the READER chose and
 *  scrolls inside it.
 *
 *  Collapse is a POINT ON THE RANGE, not a second control: keep pushing the
 *  edge past the floor and the panel folds to its bar; pull back up and it
 *  returns. That makes a separate Hide/Show button redundant — one edge answers
 *  both "how much room" and "any room at all". `collapsePx` is where the fold
 *  happens, and the gap between it and `minPx` is the hysteresis: you must
 *  travel that far past the floor to collapse, and the same distance back to
 *  reopen, so a jittery pointer at the floor cannot flap the panel.
 *
 *  Collapse is CONTROLLED (`collapsed` + `onCollapsedChange`) because the choice
 *  is scoped differently from the height: a height is one reading preference for
 *  the whole app, while "not on this screen" belongs to the screen. The height
 *  survives collapse, so reopening restores the size the reader had picked.
 *
 *  The drag mirrors `VerticalSplit`'s (same document-level listeners, same
 *  localStorage persistence) minus the split: this panel has one movable edge
 *  and a fixed ceiling, where the splitter has two panes negotiating one total.
 *
 *  `maxPx` is the ceiling in pixels; the caller is still responsible for a
 *  relative cap (a `max-h-[70%]` class) so a stored height from a tall window
 *  cannot swallow a short pane. Every read re-clamps, so a stale stored value
 *  can never strand the panel off-screen. */
export function useResizableHeight({
  storageKey,
  defaultPx,
  minPx,
  maxPx,
  collapsePx,
  collapsed,
  onCollapsedChange,
  /** Keyboard step for the handle's arrow keys; shift multiplies it by 3. */
  stepPx = 16,
}: {
  storageKey: string
  defaultPx: number
  minPx: number
  maxPx: number
  /** Drag the edge to this height or below and the panel collapses. Must sit
   *  below `minPx` — the gap is the travel needed to fold, and to unfold. */
  collapsePx: number
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  stepPx?: number
}): {
  height: number
  dragging: boolean
  /** Spread onto the drag handle element. */
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void
    onKeyDown: (e: React.KeyboardEvent) => void
    onDoubleClick: () => void
    role: 'separator'
    tabIndex: 0
    'aria-orientation': 'horizontal'
    'aria-valuenow': number
    'aria-valuemin': 0
    'aria-valuemax': number
    'aria-valuetext': string
  }
} {
  const clamp = useCallback(
    (n: number): number => Math.max(minPx, Math.min(maxPx, Math.round(n))),
    [minPx, maxPx],
  )
  const [height, setHeight] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      const n = raw == null ? NaN : Number(raw)
      if (Number.isFinite(n)) return clamp(n)
    } catch { /* a blocked storage is not a reason to render nothing */ }
    return clamp(defaultPx)
  })
  // The drag origin IS the dragging flag: the pointer's y and the height the
  // edge started from, or null when no drag is in flight. One field rather than
  // a boolean beside a ref, so "dragging with no origin" cannot be represented —
  // the move handler then needs no null guard, and there is no unreachable arm
  // to explain to the coverage gate. Deltas are measured from this origin rather
  // than accumulated per move, so a fast drag that outruns a repaint still
  // lands where the pointer is.
  const [drag, setDrag] = useState<{ y: number; startHeight: number } | null>(null)

  useEffect(() => {
    try { localStorage.setItem(storageKey, String(height)) } catch { /* ignore */ }
  }, [storageKey, height])

  useEffect(() => {
    if (drag === null) return
    // The handle is the panel's TOP edge, so dragging UP (a falling clientY)
    // makes the panel taller — hence the subtraction.
    const onMove = (e: MouseEvent): void => {
      // No button held means the mouseup never reached us — it landed before
      // this listener existed (a fast click releases inside the same frame React
      // needs to commit `drag`), or outside the window. Without this the handle
      // stays grabbed and the panel would follow a pointer that isn't dragging.
      if (e.buttons === 0) { setDrag(null); return }
      // Where the reader is asking the edge to be, BEFORE any clamp — the clamp
      // would hide the overshoot that the fold reads.
      const wanted = drag.startHeight - (e.clientY - drag.y)
      if (collapsed) {
        // Folded: nothing to resize until the pull clears the floor again. The
        // origin was captured at `collapsePx`, so that is a `minPx - collapsePx`
        // pull — the same distance the fold cost.
        if (wanted >= minPx) { onCollapsedChange(false); setHeight(clamp(wanted)) }
        return
      }
      if (wanted <= collapsePx) { onCollapsedChange(true); return }
      setHeight(clamp(wanted))
    }
    const onUp = (): void => { setDrag(null) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [drag, clamp, collapsed, collapsePx, minPx, onCollapsedChange])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    // A folded panel has no height to start from, so the origin is the fold
    // point: the edge then behaves as if it were parked just under the floor,
    // and one short pull brings it back.
    setDrag({ y: e.clientY, startHeight: collapsed ? collapsePx : height })
  }, [collapsed, collapsePx, height])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? stepPx * 3 : stepPx
    if (e.key === 'Enter' || e.key === ' ') onCollapsedChange(!collapsed)
    else if (e.key === 'ArrowUp') {
      // Same as the drag: the first step out of a fold reopens rather than grows.
      if (collapsed) onCollapsedChange(false)
      else setHeight((h) => clamp(h + step))
    } else if (e.key === 'ArrowDown') {
      if (collapsed) return
      // Stepping off the floor folds, so the keyboard reaches every state the
      // pointer can.
      else if (height - step < minPx) onCollapsedChange(true)
      else setHeight((h) => clamp(h - step))
    } else if (e.key === 'Home') { onCollapsedChange(false); setHeight(clamp(maxPx)) }
    else if (e.key === 'End') onCollapsedChange(true)
    else return
    e.preventDefault()
  }, [clamp, collapsed, height, maxPx, minPx, onCollapsedChange, stepPx])

  const onDoubleClick = useCallback(() => { onCollapsedChange(!collapsed) }, [collapsed, onCollapsedChange])

  return {
    height,
    dragging: drag !== null,
    handleProps: {
      onMouseDown,
      onKeyDown,
      onDoubleClick,
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'horizontal',
      // Folded reads as zero on the same scale, so a screen reader hears the
      // fold as the bottom of the range rather than as a missing control.
      'aria-valuenow': collapsed ? 0 : height,
      'aria-valuemin': 0,
      'aria-valuemax': maxPx,
      'aria-valuetext': collapsed ? 'collapsed' : `${height} pixels tall`,
    },
  }
}
