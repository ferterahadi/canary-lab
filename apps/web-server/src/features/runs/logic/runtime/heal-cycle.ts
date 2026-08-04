// Pure heal-cycle state machine. No I/O — given a sequence of (signal, failure-
// signature) events plus a max-cycles cap, decides what the orchestrator
// should do next.
//
// The orchestrator owns the actual fs/pty side effects; this module is
// deterministic and trivially unit-testable.

// Finite by default: an unattended run must not heal forever. 10 cycles is
// far past the point where an agent that hasn't converged will converge —
// the stuck-set give-up below usually fires first. Overridable per run via
// `maxCycles`.
export const AUTO_HEAL_MAX_CYCLES = 10

// Give up when the EXACT same failing set has been observed this many times
// in a row plus one — i.e. `DEFAULT_NO_PROGRESS_LIMIT` consecutive fix
// attempts changed nothing. Distinct from the per-test escalation threshold
// (heal-escalation.ts): escalation changes tactic, this stops the loop.
export const DEFAULT_NO_PROGRESS_LIMIT = 6

export type HealSignalKind = 'restart' | 'rerun'

export type HealAction =
  | { kind: 'restart-and-rerun' } // services were re-spawned, then run Playwright again
  | { kind: 'rerun-only' }         // tests/config-only change; Playwright again, services untouched
  | { kind: 'give-up'; reason: 'max-cycles' | 'no-progress' }

export interface HealCycleStateOptions {
  maxCycles?: number
  /** Consecutive identical-failing-set observations (beyond the first) before
   *  the loop gives up as no-progress. Defaults to
   *  `min(maxCycles, DEFAULT_NO_PROGRESS_LIMIT)`. */
  noProgressLimit?: number
}

/** Why the loop should stop, or that it shouldn't. A discriminated union rather
 *  than `{ shouldHeal: boolean; reason?: … }`: every refusal names a reason, so
 *  the caller reports `decision.reason` directly instead of guessing a default
 *  for a case that cannot occur. */
export type HealDecision =
  | { shouldHeal: true }
  | { shouldHeal: false; reason: 'max-cycles' | 'no-progress' }

export interface HealCycleSnapshot {
  cycle: number              // 0-based count of heal cycles completed so far
  lastFailureSignature: string
  consecutiveSameFailures: number
  // The failing-slug list from the most recently observed cycle, in the order
  // the caller supplied. Empty before the first `observeFailures` call (and
  // therefore a reliable "is this the first heal cycle?" signal for callers
  // that want to render a delta vs the previous cycle).
  lastFailingSlugs: string[]
  // Longest per-test consecutive-failure streak among the currently failing
  // slugs. Unlike `consecutiveSameFailures` (which keys off the EXACT set and
  // resets when a flaky test enters or leaves), this tracks each test on its
  // own — a test that failed 3 observations in a row is stuck even when the
  // set around it churned.
  maxSlugStreak: number
}

export class HealCycleState {
  private readonly maxCycles: number
  private readonly noProgressLimit: number
  private cycle = 0
  private lastFailureSignature = ''
  private consecutiveSameFailures = 0
  private lastFailingSlugs: string[] = []
  // Per-slug consecutive-failure streaks across `observeFailures` calls. A
  // slug absent from an observation drops out (its streak resets if it comes
  // back later).
  private slugStreaks = new Map<string, number>()

  constructor(opts: HealCycleStateOptions = {}) {
    this.maxCycles = opts.maxCycles ?? AUTO_HEAL_MAX_CYCLES
    this.noProgressLimit = opts.noProgressLimit ?? Math.min(this.maxCycles, DEFAULT_NO_PROGRESS_LIMIT)
  }

  // Called when Playwright finishes a run. Returns whether we should attempt
  // another heal cycle (true) or stop (false). Updates internal failure-streak
  // tracking on two axes:
  //
  // - Set identity (`consecutiveSameFailures`): the whole failing set is
  //   unchanged → zero progress. Drives the no-progress give-up.
  // - Per-slug streaks: each individual test's consecutive failures. Drives
  //   the stuck-test escalation (`stuckSlugs`) — flake-tolerant, so one test
  //   blinking in or out of the set can't reset the "you're stuck on these"
  //   signal for the tests that keep failing.
  //
  // Accepts the raw failing-slug array (not a pre-joined signature) so the
  // state can remember the slug list itself, which feeds the heal-index
  // delta-vs-previous-cycle section. The set-identity check keys off a
  // sorted-join signature so ordering changes from the test runner can't
  // masquerade as progress.
  observeFailures(slugs: string[]): HealDecision {
    const signature = slugs.slice().sort().join('|')
    // Nothing failing (or every slug blank) means there is nothing for a heal
    // cycle to fix. It carries a reason like every other stop so callers never
    // have to invent one for a `reason`-less refusal.
    if (signature === '') return { shouldHeal: false, reason: 'no-progress' }
    if (this.cycle >= this.maxCycles) return { shouldHeal: false, reason: 'max-cycles' }
    if (signature === this.lastFailureSignature) {
      this.consecutiveSameFailures += 1
    } else {
      this.consecutiveSameFailures = 1
      this.lastFailureSignature = signature
    }
    const next = new Map<string, number>()
    for (const slug of slugs) {
      next.set(slug, (this.slugStreaks.get(slug) ?? 0) + 1)
    }
    this.slugStreaks = next
    this.lastFailingSlugs = slugs.slice()
    if (this.consecutiveSameFailures > this.noProgressLimit) {
      return { shouldHeal: false, reason: 'no-progress' }
    }
    return { shouldHeal: true }
  }

  // Currently failing slugs whose consecutive-failure streak has reached
  // `threshold` observations, in last-observed order. The escalation block
  // keys off this instead of set identity so a flaky sibling can't mask a
  // genuinely stuck test.
  stuckSlugs(threshold: number): string[] {
    // Every slug in lastFailingSlugs was just written into slugStreaks by the
    // same observeFailures call, so the lookup is always defined.
    return this.lastFailingSlugs.filter((slug) => this.slugStreaks.get(slug)! >= threshold)
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
    let maxSlugStreak = 0
    for (const slug of this.lastFailingSlugs) {
      // Same invariant as stuckSlugs: always written in the same call.
      const streak = this.slugStreaks.get(slug)!
      if (streak > maxSlugStreak) maxSlugStreak = streak
    }
    return {
      cycle: this.cycle,
      lastFailureSignature: this.lastFailureSignature,
      consecutiveSameFailures: this.consecutiveSameFailures,
      lastFailingSlugs: this.lastFailingSlugs.slice(),
      maxSlugStreak,
    }
  }
}
