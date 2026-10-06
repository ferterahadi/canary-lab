import type { RunStoreEvent } from '../features/runs/logic/run-store'

interface RunConditionOptions<T> {
  store: {
    onEvent(listener: (event: RunStoreEvent) => void): void
    offEvent(listener: (event: RunStoreEvent) => void): void
  }
  runId: string
  read: () => T | null
  timeoutMs: number
  maxWaitMs: number
  onTimeout: () => T
  heartbeat?: { intervalMs: number; beat: () => void }
}

/** The caller owns durable outcomes; this helper owns the subscription and
 * timers, including cleanup when a store read or heartbeat throws. */
export async function waitForRunCondition<T>(options: RunConditionOptions<T>): Promise<T> {
  const immediate = options.read()
  if (immediate !== null) return immediate
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const cleanup = (): void => {
      settled = true
      clearTimeout(timer)
      clearInterval(heartbeat)
      options.store.offEvent(onEvent)
    }
    const guard = (action: () => void): void => {
      if (settled) return
      try { action() } catch (error) { cleanup(); reject(error) }
    }
    const finish = (result: T): void => { cleanup(); resolve(result) }
    const check = (): void => {
      const result = options.read()
      if (result !== null) finish(result)
    }
    const onEvent = (event: RunStoreEvent): void => {
      if (!event.runId || event.runId === options.runId) guard(check)
    }
    guard(() => {
      timer = setTimeout(() => guard(() => finish(options.onTimeout())),
        Math.min(Math.max(options.timeoutMs, 1), options.maxWaitMs))
      timer.unref()
      if (options.heartbeat) {
        const { beat, intervalMs } = options.heartbeat
        heartbeat = setInterval(() => guard(beat), intervalMs)
        heartbeat.unref()
      }
      options.store.onEvent(onEvent)
      // A synchronous subscription callback may already have settled the wait.
      guard(() => options.heartbeat?.beat())
      // Close the read/subscribe gap without relying on delivery of a push.
      guard(check)
    })
  })
}
