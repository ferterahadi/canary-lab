// An IDLE (inactivity) timeout for a spawned agent CLI: it trips only after the
// child has produced NO output for `idleMs`, not after a fixed wall-clock window.
//
// This mirrors the heal REPL's idle clock (orchestrator `waitForHealSignal`):
// every stdout/stderr chunk calls `bump()` to reset the clock, so a healthy
// agentic run (which keeps emitting tool calls/output) never trips — only a
// genuinely wedged CLI that goes silent for the full window does. A slow-but-alive
// agent is no longer punished by a hard deadline.

export interface IdleTimer {
  /** Reset the idle clock — call on every stdout/stderr chunk. */
  bump(): void
  /** Stop the timer — call from the spawn's `finish()`/cleanup. */
  stop(): void
}

export interface IdleTimerOptions {
  /** Trip after this many ms with no `bump()`. */
  idleMs: number
  /** How often to check for silence (default 10s). */
  pollMs?: number
  /** Fired once, the first time the idle window elapses with no output. */
  onIdle: (idleMs: number) => void
  /** Fired on every poll while still within the window (e.g. progress note). */
  onTick?: (idleMs: number) => void
  /** Clock source — injectable for deterministic tests. */
  now?: () => number
  /**
   * Optional monotonic activity counter (e.g. the agent session-JSONL byte
   * size). When it grows between polls the idle clock resets — this is the
   * accurate liveness signal for an agentic `claude -p` run, whose tool
   * activity lands in the JSONL, not stdout. Must not throw (return the last
   * value on read failure).
   */
  activity?: () => number
}

export function startIdleTimer(opts: IdleTimerOptions): IdleTimer {
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? 10_000
  let last = now()
  let fired = false
  let lastActivity = opts.activity ? opts.activity() : 0
  const interval = setInterval(() => {
    if (fired) return
    if (opts.activity) {
      const a = opts.activity()
      if (a > lastActivity) {
        lastActivity = a
        last = now()
      }
    }
    const idle = now() - last
    if (idle >= opts.idleMs) {
      fired = true
      opts.onIdle(idle)
      return
    }
    opts.onTick?.(idle)
  }, pollMs)
  // Don't keep the event loop alive on the timer's account.
  interval.unref?.()
  return {
    bump(): void {
      last = now()
    },
    stop(): void {
      clearInterval(interval)
    },
  }
}
