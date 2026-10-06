export interface ConditionWaitOptions<T> {
  read: () => T | null
  /** Registration must either return its cleanup or undo itself before throwing. */
  subscribe: (notify: () => void) => () => void
  timeoutMs: number
  maxWaitMs: number
  onTimeout: () => T
  heartbeat?: { intervalMs: number; beat: () => void }
  cancellation?: { signal: AbortSignal; result: () => T }
}

/** Domain readers own outcomes; this owns the read/subscribe gap and disposal. */
export async function waitForCondition<T>(options: ConditionWaitOptions<T>): Promise<T> {
  if (options.cancellation?.signal.aborted) return options.cancellation.result()
  const immediate = options.read()
  if (immediate !== null) return immediate
  return new Promise<T>((resolve, reject) => {
    let outcome: { value: T } | { error: unknown } | undefined
    let attaching = true
    let checking = false
    let checkAgain = false
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const complete = (): void => {
      clearTimeout(timer)
      clearInterval(heartbeat)
      options.cancellation?.signal.removeEventListener('abort', cancel)
      try { unsubscribe?.() } catch (error) { outcome = { error } }
      if ('error' in outcome!) reject(outcome.error)
      else resolve(outcome!.value)
    }
    const settle = (result: NonNullable<typeof outcome>): void => {
      if (outcome) return
      outcome = result
      // A synchronous notification can settle before subscribe returns cleanup.
      if (!attaching) complete()
    }
    const guard = (action: () => void): void => {
      if (outcome) return
      try { action() } catch (error) { settle({ error }) }
    }
    const cancel = (): void => guard(() => settle({ value: options.cancellation!.result() }))
    const check = (): void => guard(() => {
      if (checking) { checkAgain = true; return }
      checking = true
      try {
        do {
          checkAgain = false
          const value = options.read()
          if (value !== null) settle({ value })
        } while (checkAgain && !outcome)
      } finally { checking = false }
    })
    guard(() => {
      options.cancellation?.signal.addEventListener('abort', cancel, { once: true })
      if (options.cancellation?.signal.aborted) { cancel(); return }
      timer = setTimeout(() => guard(() => settle({ value: options.onTimeout() })),
        Math.min(Math.max(options.timeoutMs, 1), options.maxWaitMs))
      timer.unref()
      if (options.heartbeat) {
        heartbeat = setInterval(() => guard(options.heartbeat!.beat), options.heartbeat.intervalMs)
        heartbeat.unref()
      }
      unsubscribe = options.subscribe(check)
      guard(() => options.heartbeat?.beat())
      check()
    })
    attaching = false
    if (outcome) complete()
  })
}
