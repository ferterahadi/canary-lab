import { useMouseDrag } from '@/shared/state/use-mouse-drag'
import { useCallback, useEffect, useState } from 'react'
import { readStored, writeStored } from '@/shared/state/browser-storage'

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
 *  The shared mouse-drag hook also serves the splitters. This panel has one
 *  movable edge and a fixed ceiling; a splitter negotiates two panes' sizes.
 *
 *  `maxPx` is the ceiling in pixels. A panel whose real ceiling is the room its
 *  container has passes `ceilingPx` too: a drag or key step then stops at that
 *  live measurement, and a drag starts from the height actually shown rather
 *  than a taller stored one, so the edge never has dead travel to burn. The
 *  caller still caps the rendered height (a `max-h-full` class) for a window
 *  that shrinks under a stored height. Every read re-clamps, so a stale stored
 *  value can never strand the panel off-screen. */
export function useResizableHeight({
  storageKey,
  defaultPx,
  minPx,
  maxPx,
  collapsePx,
  collapsed,
  onCollapsedChange,
  ceilingPx,
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
  /** The live room the panel may grow into, read at drag and key time; null
   *  while it can't be measured. */
  ceilingPx?: () => number | null
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
    (n: number): number => Math.max(minPx, Math.min(maxPx, ceilingPx?.() ?? maxPx, Math.round(n))),
    [minPx, maxPx, ceilingPx],
  )
  const [height, setHeight] = useState<number>(() => {
    const raw = readStored(storageKey)
    const n = raw == null ? NaN : Number(raw)
    return clamp(Number.isFinite(n) ? n : defaultPx)
  })
  useEffect(() => {
    writeStored(storageKey, String(height))
  }, [storageKey, height])

  const { origin: drag, start } = useMouseDrag<{ y: number; startHeight: number }>((origin, e) => {
    // The handle is the TOP edge: moving up increases height. Read the raw
    // overshoot before clamping so the fold/reopen hysteresis stays intact.
    const wanted = origin.startHeight - (e.clientY - origin.y)
    if (collapsed) {
      if (wanted >= minPx) { onCollapsedChange(false); setHeight(clamp(wanted)) }
      return
    }
    if (wanted <= collapsePx) { onCollapsedChange(true); return }
    setHeight(clamp(wanted))
  })

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    // A folded panel has no height to start from, so the origin is the fold
    // point: the edge then behaves as if it were parked just under the floor,
    // and one short pull brings it back.
    start({ y: e.clientY, startHeight: collapsed ? collapsePx : clamp(height) })
  }, [clamp, collapsed, collapsePx, height, start])

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
