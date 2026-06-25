import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

export interface PanelConfig {
  id: string
  minWidth: number
  defaultWidth: number
  collapsible: boolean
  /** Vertical placement of the collapse button on this panel's right-side
   *  handle. Defaults to 'center'. */
  collapseButtonY?: 'top' | 'center' | 'bottom'
  content: ReactNode
}

const STORAGE_KEY = 'canary-lab.panel-widths'
const HANDLE_WIDTH = 4

function loadWidths(panels: PanelConfig[]): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, number>
      return panels.map((p) => {
        const w = saved[p.id]
        return typeof w === 'number' && w >= p.minWidth ? w : p.defaultWidth
      })
    }
  } catch { /* ignore */ }
  return panels.map((p) => p.defaultWidth)
}

function saveWidths(panels: PanelConfig[], widths: number[]): void {
  try {
    const obj: Record<string, number> = {}
    panels.forEach((p, i) => { obj[p.id] = widths[i] })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
  } catch { /* ignore */ }
}

export function ResizablePanels({ panels }: { panels: PanelConfig[] }) {
  const [widths, setWidths] = useState<number[]>(() => loadWidths(panels))
  const [collapsed, setCollapsed] = useState<boolean[]>(() => panels.map(() => false))
  const [containerWidth, setContainerWidth] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ index: number; startX: number; startWidths: number[] } | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const displayWidths = computePanelWidths(panels, widths, collapsed, containerWidth)

  useEffect(() => {
    saveWidths(panels, widths)
  }, [panels, widths])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const measure = (): void => setContainerWidth(node.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  const onMouseDown = useCallback((handleIndex: number, e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = {
      index: handleIndex,
      startX: e.clientX,
      startWidths: [...displayWidths],
    }
    setDragging(handleIndex)
  }, [displayWidths])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      if (!dragRef.current) return
      const { index, startX, startWidths } = dragRef.current
      const delta = e.clientX - startX
      const leftIdx = index
      const rightIdx = index + 1

      let newLeft = startWidths[leftIdx] + delta
      let newRight = startWidths[rightIdx] - delta

      const leftMin = panels[leftIdx].minWidth
      const rightMin = panels[rightIdx].minWidth

      if (newLeft < leftMin) {
        newRight += newLeft - leftMin
        newLeft = leftMin
      }
      if (newRight < rightMin) {
        newLeft += newRight - rightMin
        newRight = rightMin
      }

      if (newLeft < leftMin || newRight < rightMin) return

      setWidths((prev) => {
        const next = [...prev]
        next[leftIdx] = newLeft
        next[rightIdx] = newRight
        return next
      })
    }

    const onMouseUp = (): void => {
      dragRef.current = null
      setDragging(null)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [panels])

  const toggleCollapse = useCallback((index: number) => {
    setCollapsed((prev) => {
      const next = [...prev]
      next[index] = !next[index]
      return next
    })
  }, [])

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-base)' }}
    >
      {panels.map((panel, i) => {
        const isCollapsed = collapsed[i]
        const isLast = i === panels.length - 1
        const panelWidth = displayWidths[i] ?? (isCollapsed ? 0 : widths[i])

        return (
          <div key={panel.id} className="contents">
            <div
              className="shrink-0 overflow-hidden transition-[width] duration-200"
              style={{
                width: isCollapsed ? 0 : `${panelWidth}px`,
                minWidth: isCollapsed ? 0 : undefined,
              }}
            >
              <div className="cl-panel h-full overflow-hidden">
                {panel.content}
              </div>
            </div>
            {!isLast && (
              <div
                className={`resize-handle${dragging === i ? ' dragging' : ''}`}
                style={{ position: 'relative' }}
                onMouseDown={(e) => onMouseDown(i, e)}
              >
                {panel.collapsible && (
                  <button
                    type="button"
                    className={`panel-collapse-btn panel-collapse-btn--${panel.collapseButtonY ?? 'center'}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleCollapse(i)
                    }}
                    aria-label={isCollapsed ? 'Expand panel' : 'Collapse panel'}
                    title={isCollapsed ? 'Expand' : 'Collapse'}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      {isCollapsed ? <polyline points="6 4 11 8 6 12" /> : <polyline points="10 4 5 8 10 12" />}
                    </svg>
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function computePanelWidths(
  panels: Pick<PanelConfig, 'minWidth'>[],
  widths: number[],
  collapsed: boolean[],
  containerWidth: number,
): number[] {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return panels.map((panel, index) => collapsed[index] ? 0 : widths[index] ?? panel.minWidth)
  }

  const totalHandleWidth = Math.max(0, panels.length - 1) * HANDLE_WIDTH
  let remaining = Math.max(0, containerWidth - totalHandleWidth)
  const minimums = panels.map((panel, index) => collapsed[index] ? 0 : panel.minWidth)
  const resolved: number[] = []

  for (let index = 0; index < panels.length; index++) {
    const minWidth = minimums[index]
    if (index === panels.length - 1) {
      resolved[index] = collapsed[index] ? 0 : Math.max(minWidth, remaining)
      break
    }

    const laterMin = minimums.slice(index + 1).reduce((sum, value) => sum + value, 0)
    const maxWidth = Math.max(minWidth, remaining - laterMin)
    const desired = collapsed[index] ? 0 : widths[index] ?? panels[index].minWidth
    const nextWidth = Math.min(Math.max(desired, minWidth), maxWidth)
    resolved[index] = nextWidth
    remaining -= nextWidth
  }

  return resolved
}
