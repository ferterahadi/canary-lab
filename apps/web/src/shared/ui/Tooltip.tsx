import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

// Lightweight, instant tooltip. The app otherwise leans on native `title`, which
// is slow (~1s) and easy to miss; this shows immediately on hover/focus and
// renders in a PORTAL with position:fixed so it's never clipped by a scrolling
// or overflow-hidden ancestor (e.g. the Features list).
//
// Uses cloneElement so it adds NO wrapper element — the child keeps its exact
// classes, margins, and flex behavior.
//
// Position is CLAMPED to the viewport: the tip is measured after render (in a
// layout effect, before paint) and nudged inward so it can't be cut off at a
// window edge — e.g. a badge hugging the left edge of the Features column.

/** Distance from the anchor's edge to the tip. */
const GAP = 6
/** Keep-out from the viewport edges. Was the same constant as GAP, which meant
 *  a safe screen margin and a visual attachment distance could not be tuned
 *  apart. */
const EDGE = 8

/** Marks the element the tip should be POSITIONED against, when that isn't the
 *  whole hover target. A stage fact tile is ~90px tall and hovers as one piece
 *  (a 12px `?` is a poor mouse target), but measuring from the tile's bottom put
 *  the tip most of a tile below the `?` that advertised it — far enough to read
 *  as a detached box. Put this on the mark instead and the tip drops from the
 *  mark, while the whole tile still triggers it.
 *
 *  A string, not a ref, because `Tooltip` clones its child and owns no DOM node
 *  of its own — the lookup is one `querySelector` at hover time, on the element
 *  the pointer already entered. */
export const TOOLTIP_ANCHOR_ATTR = 'data-tooltip-anchor'

export function Tooltip({
  label,
  placement = 'bottom',
  children,
}: {
  label: string
  placement?: 'top' | 'bottom'
  children: ReactElement
}) {
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; centerX: number } | null>(null)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  const show = (el: Element) => {
    // Position against the marked sub-element when the child names one; the
    // hover target stays whatever the caller wrapped.
    const r = (el.querySelector(`[${TOOLTIP_ANCHOR_ATTR}]`) ?? el).getBoundingClientRect()
    setAnchor({ top: r.top, bottom: r.bottom, centerX: r.left + r.width / 2 })
    setCoords(null)
  }
  const hide = () => { setAnchor(null); setCoords(null) }

  // Measure the rendered tip and clamp it inside the viewport before paint.
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return
    const { width, height } = tipRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = Math.min(Math.max(EDGE, anchor.centerX - width / 2), Math.max(EDGE, vw - width - EDGE))
    let top = placement === 'top' ? anchor.top - GAP - height : anchor.bottom + GAP
    // Flip to the other side if the preferred placement overflows vertically.
    if (top < EDGE) top = anchor.bottom + GAP
    if (top + height > vh - EDGE) top = Math.max(EDGE, anchor.top - GAP - height)
    setCoords({ top, left })
  }, [anchor, placement, label])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (children as ReactElement<any>).props ?? {}
  const child = cloneElement(children as ReactElement<Record<string, unknown>>, {
    onMouseEnter: (e: { currentTarget: Element }) => { show(e.currentTarget); props.onMouseEnter?.(e) },
    onMouseLeave: (e: unknown) => { hide(); props.onMouseLeave?.(e) },
    onFocus: (e: { currentTarget: Element }) => { show(e.currentTarget); props.onFocus?.(e) },
    onBlur: (e: unknown) => { hide(); props.onBlur?.(e) },
  })

  return (
    <>
      {child}
      {anchor && createPortal(
        <div
          ref={tipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            top: coords?.top ?? anchor.bottom + GAP,
            left: coords?.left ?? anchor.centerX,
            // Hidden for the one pre-paint commit before coords are measured, so
            // it never flashes at an unclamped position.
            visibility: coords ? 'visible' : 'hidden',
            zIndex: 300,
            pointerEvents: 'none',
            maxWidth: 260,
            padding: '4px 8px',
            borderRadius: 6,
            fontSize: 11.5,
            lineHeight: 1.35,
            whiteSpace: 'normal',
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-default)',
            boxShadow: 'var(--shadow-popover)',
          }}
        >
          {label}
        </div>,
        document.body,
      )}
    </>
  )
}
