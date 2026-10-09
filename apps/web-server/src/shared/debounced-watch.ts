// Shared timing for the read-side filesystem observers (repository status,
// run artifacts): how long an unread observation keeps its watch, and how a
// burst of fs.watch events is folded into one notification.

/** How long an observation outlives its last read before its watch is dropped. */
export const OBSERVATION_LEASE_MS = 90_000
const DEBOUNCE_MS = 250
const MAX_DELAY_MS = 1000

export interface CappedDebounce {
  /** Record a change: (re)start the quiet window, never past the burst's cap. */
  schedule(): void
  /** Drop a scheduled flush; the burst start is kept. */
  cancel(): void
}

/** Trailing debounce capped from the first change of a burst: each change
 *  restarts a 250ms quiet window, but a steady stream still flushes within 1s
 *  of its first change. The burst resets just before `flush` runs. */
export function createCappedDebounce(flush: () => void): CappedDebounce {
  let timer: ReturnType<typeof setTimeout> | undefined
  let firstChange: number | undefined
  return {
    schedule() {
      firstChange ??= Date.now()
      clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        firstChange = undefined
        flush()
      }, Math.min(DEBOUNCE_MS, Math.max(0, MAX_DELAY_MS - (Date.now() - firstChange))))
      timer.unref()
    },
    cancel() {
      clearTimeout(timer)
    },
  }
}
