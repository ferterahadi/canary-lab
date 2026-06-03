import {
  computeBenchmarkReport,
  type ArmIterationResult,
  type BenchmarkReport,
} from './report'
import type { ArmMode } from './types'

// The race control loop: runs the two arms IN PARALLEL each iteration, barriers
// on both finishing, resets both worktrees to the frozen sabotage SHA between
// iterations, accumulates results, and produces the comparison report.
//
// Pure control flow with injected `runArm` / `resetArms` so it's unit-testable
// without real worktrees, RunOrchestrators, or agents. The full
// BenchmarkOrchestrator composes this with the sabotage phase + real wiring.

const ARM_MODES: Record<'A' | 'B', ArmMode> = { A: 'harness', B: 'baseline' }

export interface BenchmarkRaceDeps {
  iterations: number
  sabotageSha: string
  /** Run one arm for one iteration to terminal state, returning its result.
   *  Call `onStart(runId)` as soon as the arm's run is created so the UI can
   *  attach its live RunDetailColumn before the arm finishes. */
  runArm: (
    arm: 'A' | 'B',
    mode: ArmMode,
    iteration: number,
    onStart: (runId: string) => void,
  ) => Promise<ArmIterationResult>
  /** `git reset --hard <sabotageSha>` on both arm worktrees between iterations. */
  resetArms: (sabotageSha: string) => Promise<void>
  onResult?: (result: ArmIterationResult) => void
  onIterationComplete?: (iteration: number) => void
  /** Fired when an arm's run is created (with its runId) — before it finishes. */
  onArmStart?: (arm: 'A' | 'B', iteration: number, runId: string) => void
  /** When it returns true, the loop stops before the next iteration. */
  isAborted?: () => boolean
  /** Run both arms concurrently (default). When false — set by the runner when
   *  the box can't admit two arm runs at once — they run one after the other so
   *  a saturated machine degrades gracefully instead of thrashing. */
  parallel?: boolean
}

export class BenchmarkRace {
  readonly results: ArmIterationResult[] = []

  constructor(private readonly deps: BenchmarkRaceDeps) {}

  // A thrown arm (agent crash, boot failure, …) becomes a failed iteration so
  // the barrier can't deadlock the other arm.
  private async runArmSafely(arm: 'A' | 'B', iteration: number): Promise<ArmIterationResult> {
    try {
      return await this.deps.runArm(arm, ARM_MODES[arm], iteration, (runId) =>
        this.deps.onArmStart?.(arm, iteration, runId),
      )
    } catch {
      return { arm, iteration, healed: false, healCycles: 0, wallClockMs: 0 }
    }
  }

  async runRace(): Promise<BenchmarkReport> {
    const { iterations, sabotageSha, resetArms } = this.deps
    for (let k = 1; k <= iterations; k++) {
      if (this.deps.isAborted?.()) break
      // BARRIER: both arms finish iteration k before we advance. Normally they
      // run concurrently; on a saturated box (parallel:false) they run
      // sequentially so we don't oversubscribe — heal-cycle count stays the
      // fair metric either way (only wall-clock is contention-sensitive).
      const armResults =
        this.deps.parallel === false
          ? [await this.runArmSafely('A', k), await this.runArmSafely('B', k)]
          : await Promise.all([this.runArmSafely('A', k), this.runArmSafely('B', k)])
      for (const r of armResults) {
        this.results.push(r)
        this.deps.onResult?.(r)
      }
      this.deps.onIterationComplete?.(k)
      if (k < iterations && !this.deps.isAborted?.()) await resetArms(sabotageSha)
    }
    return computeBenchmarkReport(this.results)
  }
}
