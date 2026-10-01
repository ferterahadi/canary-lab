import { useCallback, useState } from 'react'
import type { RefObject } from 'react'
import { useAnchoredPosition } from '@/shared/ui/use-anchored-position'

export function useRunMenuPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
): { top: number; left: number } | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const reposition = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = rect.right - width
    if (left < 8) left = 8
    const maxLeft = window.innerWidth - width - 8
    if (left > maxLeft) left = maxLeft
    setPos({ top: rect.bottom + 6, left })
  }, [anchorRef, width])
  useAnchoredPosition(open, reposition, 'layout')
  return open ? pos : null
}
