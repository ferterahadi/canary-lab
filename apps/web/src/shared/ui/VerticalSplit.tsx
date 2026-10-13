import { useMouseDrag } from '@/shared/state/use-mouse-drag'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { readStored, writeStored } from '@/shared/state/browser-storage'

interface Props {
  storageKey: string
  defaultTopPercent: number
  minTopPx: number
  minBottomPx: number
  top: ReactNode
  bottom: ReactNode
  /** When true, render a collapse/expand button on the handle that collapses
   *  the TOP pane so the bottom pane fills the full height. */
  collapsible?: boolean
}

export function VerticalSplit({ storageKey, defaultTopPercent, minTopPx, minBottomPx, top, bottom, collapsible = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [topHeight, setTopHeight] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const resizedRef = useRef(false)

  // Initialize from localStorage or default percent of container height after mount
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const totalH = el.clientHeight
    let initial: number | null = null
    const raw = readStored(storageKey)
    if (raw) {
      const n = Number(raw)
      if (Number.isFinite(n) && n >= minTopPx && n <= totalH - minBottomPx) initial = n
    }
    if (initial == null) initial = Math.max(minTopPx, Math.min(totalH - minBottomPx, totalH * (defaultTopPercent / 100)))
    setTopHeight(initial)
  }, [storageKey, defaultTopPercent, minTopPx, minBottomPx])

  const { origin: drag, start } = useMouseDrag<{ y: number; startTop: number }>((ctx, e) => {
    const el = containerRef.current
    if (!el) return
    const totalH = el.clientHeight
    const dy = e.clientY - ctx.y
    let next = ctx.startTop + dy
    if (next < minTopPx) next = minTopPx
    if (next > totalH - minBottomPx) next = totalH - minBottomPx
    resizedRef.current = true
    setTopHeight(next)
  })
  const dragging = drag !== null

  // Storage writes block the drag path, so persist only after release.
  useEffect(() => {
    if (dragging || !resizedRef.current || topHeight == null) return
    resizedRef.current = false
    writeStored(storageKey, String(topHeight))
  }, [dragging, storageKey, topHeight])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (topHeight == null) return
    start({ y: e.clientY, startTop: topHeight })
  }, [topHeight, start])

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      <div
        className={`min-h-0 overflow-hidden${dragging ? '' : ' transition-[height] duration-200'}`}
        style={{ height: collapsed ? 0 : (topHeight ?? '45%') }}
      >
        {top}
      </div>
      <div
        className={`vertical-resize-handle${dragging ? ' dragging' : ''}`}
        style={collapsed ? { cursor: 'default' } : undefined}
        onMouseDown={collapsed ? undefined : onMouseDown}
      >
        {collapsible && (
          <button
            type="button"
            className="vertical-collapse-btn"
            onClick={(e) => {
              e.stopPropagation()
              setCollapsed((c) => !c)
            }}
            aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {collapsed ? <polyline points="4 6 8 11 12 6" /> : <polyline points="4 10 8 5 12 10" />}
            </svg>
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{bottom}</div>
    </div>
  )
}
