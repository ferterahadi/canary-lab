import { useMemo } from 'react'
import { formatElapsedSeconds } from '@/shared/lib/format'
import { useNow } from './use-now'

/** Time since `iso` as a live clock ("12s", "1m 14s", "1h 02m"), re-rendered
 *  once a second. The elapsed clock is the one liveness signal that survives
 *  reduced motion, and it's what separates a 3-second gap from a stall. Null
 *  while there is nothing to time — no stamp, an unparseable one, or a delta
 *  that is negative or over a day, which means the producer's clock disagrees
 *  with the browser's: no figure beats a wrong one. Pass `undefined` to stop
 *  the tick once the work settles. */
export function useElapsed(iso: string | undefined): string | null {
  const startedAt = useMemo(() => {
    if (!iso) return null
    const t = Date.parse(iso)
    return Number.isFinite(t) ? t : null
  }, [iso])
  const now = useNow({ enabled: startedAt !== null, resetKey: startedAt, refreshOnReset: startedAt !== null })
  if (startedAt === null) return null
  const ms = now - startedAt
  if (ms < 0 || ms > 86_400_000) return null
  return formatElapsedSeconds(ms / 1000)
}
