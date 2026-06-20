import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

interface Props {
  storageKey: string
  defaultTopPercent: number
  minTopPx: number
  minBottomPx: number
  top: ReactNode
  bottom: ReactNode
}

export function VerticalSplit({ storageKey, defaultTopPercent, minTopPx, minBottomPx, top, bottom }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [topHeight, setTopHeight] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragStartRef = useRef<{ y: number; startTop: number } | null>(null)

  // Initialize from localStorage or default percent of container height after mount
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const totalH = el.clientHeight
    let initial: number | null = null
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const n = Number(raw)
        if (Number.isFinite(n) && n >= minTopPx && n <= totalH - minBottomPx) initial = n
      }
    } catch { /* ignore */ }
    if (initial == null) initial = Math.max(minTopPx, Math.min(totalH - minBottomPx, totalH * (defaultTopPercent / 100)))
    setTopHeight(initial)
  }, [storageKey, defaultTopPercent, minTopPx, minBottomPx])

  useEffect(() => {
    if (topHeight == null) return
    try { localStorage.setItem(storageKey, String(topHeight)) } catch { /* ignore */ }
  }, [storageKey, topHeight])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (topHeight == null) return
    dragStartRef.current = { y: e.clientY, startTop: topHeight }
    setDragging(true)
  }, [topHeight])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      const ctx = dragStartRef.current
      const el = containerRef.current
      if (!ctx || !el) return
      const totalH = el.clientHeight
      const dy = e.clientY - ctx.y
      let next = ctx.startTop + dy
      if (next < minTopPx) next = minTopPx
      if (next > totalH - minBottomPx) next = totalH - minBottomPx
      setTopHeight(next)
    }
    const onMouseUp = (): void => {
      dragStartRef.current = null
      setDragging(false)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [minTopPx, minBottomPx])

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 overflow-hidden" style={{ height: topHeight ?? '45%' }}>
        {top}
      </div>
      <div
        className={`vertical-resize-handle${dragging ? ' dragging' : ''}`}
        onMouseDown={onMouseDown}
      />
      <div className="min-h-0 flex-1 overflow-hidden">{bottom}</div>
    </div>
  )
}
