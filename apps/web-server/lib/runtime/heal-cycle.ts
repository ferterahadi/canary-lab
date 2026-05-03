// Pure heal-cycle state machine. No I/O — given a sequence of (signal, failure-
// signature) events plus a max-cycles cap, decides what the orchestrator
// should do next.
//
// The orchestrator owns the actual fs/pty side effects; this module is
// deterministic and trivially unit-testable.

export const AUTO_HEAL_MAX_CYCLES = 3

export type HealSignalKind = 'restart' | 'rerun'

export type HealAction =
  | { kind: 'restart-and-rerun' } // services were re-spawned, then run Playwright again
  | { kind: 'rerun-only' }         // tests/config-only change; Playwright again, services untouched
  | { kind: 'give-up'; reason: 'max-cycles' | 'no-progress' }

export interface HealCycleStateOptions {
  maxCycles?: number
}

export interface HealCycleSnapshot {
  cycle: number              // 0-based count of heal cycles completed so far
  lastFailureSignature: string
  consecutiveSameFailures: number
}

export class HealCycleState {
  private readonly maxCycles: number
  private cycle = 0
  private lastFailureSignature = ''
  private consecutiveSameFailures = 0

  constructor(opts: HealCycleStateOptions = {}) {
    this.maxCycles = opts.maxCycles ?? AUTO_HEAL_MAX_CYCLES
  }

  // Called when Playwright finishes a run. Returns whether we should attempt
  // another heal cycle (true) or stop (false). Updates internal failure-streak
  // tracking — three identical failure sets in a row means the agent is stuck.
  observeFailures(signature: string): { shouldHeal: boolean; reason?: 'max-cycles' | 'no-progress' } {
    if (signature === '') return { shouldHeal: false }
    if (this.cycle >= this.maxCycles) return { shouldHeal: false, reason: 'max-cycles' }
    if (signature === this.lastFailureSignature) {
      this.consecutiveSameFailures += 1
    } else {
      this.consecutiveSameFailures = 1
      this.lastFailureSignature = signature
    }
    if (this.consecutiveSameFailures > this.maxCycles) {
      return { shouldHeal: false, reason: 'no-progress' }
    }
    return { shouldHeal: true }
  }

  // Caller invokes this right before spawning the heal agent so the state
  // reflects the cycle currently in flight (1-based for display, 0-based
  // internally).
  beginCycle(): number {
    const inFlight = this.cycle
    this.cycle += 1
    return inFlight
  }

  // Translate a signal file kind into the orchestrator's next action. The
  // signal alone determines restart vs rerun semantics — `filesChanged` is a
  // future hint for selective service restart but doesn't affect the action
  // shape today (call out as a follow-up in the design doc).
  actionForSignal(kind: HealSignalKind): HealAction {
    if (kind === 'restart') return { kind: 'restart-and-rerun' }
    return { kind: 'rerun-only' }
  }

  // Called when no signal arrived (agent timed out or exited without writing
  // a signal). Stops the loop — there's nothing to retry.
  actionForNoSignal(): HealAction {
    return { kind: 'give-up', reason: 'no-progress' }
  }

  snapshot(): HealCycleSnapshot {
    return {
      cycle: this.cycle,
      lastFailureSignature: this.lastFailureSignature,
      consecutiveSameFailures: this.consecutiveSameFailures,
    }
  }
}
