import { useCallback, useState } from 'react'
import type { RefObject } from 'react'
import { useAnchoredPosition } from '@/shared/ui/use-anchored-position'
import { clampToViewport } from '@/shared/lib/viewport'

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
    setPos({ top: rect.bottom + 6, left: clampToViewport(rect, width, 'end', window.innerWidth) })
  }, [anchorRef, width])
  useAnchoredPosition(open, reposition, 'layout')
  return open ? pos : null
}
