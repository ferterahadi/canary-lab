import { useEffect, useState } from 'react'

export function useNow({ enabled = true, intervalMs = 1000, resetKey, refreshOnReset = false }: {
  enabled?: boolean
  intervalMs?: number
  resetKey?: unknown
  refreshOnReset?: boolean
} = {}): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (refreshOnReset) setNow(Date.now())
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [enabled, intervalMs, resetKey, refreshOnReset])
  return now
}
