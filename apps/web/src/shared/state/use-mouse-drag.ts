import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

/** Capture synchronously so a move or release in the same frame cannot outrun React. */
export function useMouseDrag<T extends object>(onMove: (origin: T, event: MouseEvent) => void): {
  origin: T | null
  start: (origin: T) => void
} {
  const active = useRef<T | null>(null)
  const [origin, setOrigin] = useState<T | null>(null)
  const start = useCallback((next: T) => {
    active.current = next
    setOrigin(next)
  }, [])

  const move = useEffectEvent((event: MouseEvent) => {
    if (active.current === null) return
    // A release outside the window can lose mouseup. Never apply its stray delta.
    if (event.buttons === 0) {
      active.current = null
      setOrigin(null)
      return
    }
    onMove(active.current, event)
  })

  useEffect(() => {
    const release = (): void => {
      active.current = null
      setOrigin(null)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', release)
    return () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', release)
      active.current = null
    }
  }, [])

  return { origin, start }
}
