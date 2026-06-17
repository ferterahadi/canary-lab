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
    const r = el.getBoundingClientRect()
    setAnchor({ top: r.top, bottom: r.bottom, centerX: r.left + r.width / 2 })
    setCoords(null)
  }
  const hide = () => { setAnchor(null); setCoords(null) }

  // Measure the rendered tip and clamp it inside the viewport before paint.
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return
    const margin = 8
    const { width, height } = tipRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = Math.min(Math.max(margin, anchor.centerX - width / 2), Math.max(margin, vw - width - margin))
    let top = placement === 'top' ? anchor.top - margin - height : anchor.bottom + margin
    // Flip to the other side if the preferred placement overflows vertically.
    if (top < margin) top = anchor.bottom + margin
    if (top + height > vh - margin) top = Math.max(margin, anchor.top - margin - height)
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
            top: coords?.top ?? anchor.bottom + 8,
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
            background: 'var(--bg-elevated, #1b1f27)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-default)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {label}
        </div>,
        document.body,
      )}
    </>
  )
}
