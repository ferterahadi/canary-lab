import { useCallback, useEffect, useRef, useState } from 'react'

export function useClipboardCopy({ resetAfterMs = 1500 }: { resetAfterMs?: number | null } = {}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const generation = useRef(0)
  const mounted = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clearTimer = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  const reset = useCallback(() => {
    generation.current += 1
    clearTimer()
    setCopiedKey(null)
  }, [clearTimer])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
      clearTimer()
    }
  }, [clearTimer])

  const copy = useCallback(async (value: string, key = value): Promise<boolean> => {
    if (!mounted.current) return false
    const operation = ++generation.current
    clearTimer()
    setCopiedKey(null)
    try {
      if (!navigator.clipboard) return false
      await navigator.clipboard.writeText(value)
      // A completed older write must not restore feedback after another copy,
      // dialog reset, or unmount. Callers use the result for their own errors.
      if (mounted.current && operation === generation.current) {
        setCopiedKey(key)
        if (resetAfterMs !== null) {
          timer.current = setTimeout(() => { timer.current = undefined; setCopiedKey(null) }, resetAfterMs)
        }
      }
      return true
    } catch {
      return false // The caller chooses whether to show a clipboard error.
    }
  }, [clearTimer, resetAfterMs])

  return { copy, copiedKey, reset }
}
