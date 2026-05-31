import { decideAdmission, type AdmissionConfig, type SystemResources } from './admission'
import { detectRepoCollision } from './repo-collision'
import type { QueueReason } from '../../../../shared/run-state'

/**
 * Owns the concurrent-run queue. A run that can't start now — because the
 * resource budget is full, or because it declined worktree isolation against an
 * active run on the same repo — is parked here and promoted FIFO when capacity
 * frees up (the server calls promote() on every run-end).
 *
 * The fit decision composes the two pure modules: collision detection
 * (repo-collision.ts) gates first so the user gets the right queue reason, then
 * the resource heuristic (admission.ts). The scheduler itself is dependency-
 * injected (active-run snapshot, resources, config) so it's deterministic to
 * test without a live orchestrator.
 */

export interface SchedulerActiveRun {
  runId: string
  feature: string
  /** Resolved repo paths the active run occupies. */
  repoPaths: string[]
  /** Estimated cost (see admission.estimateRunCost). */
  cost: number
}

export interface QueuedRun {
  runId: string
  feature: string
  /** Source repo paths this run will occupy. Empty when it will run in an
   *  isolated worktree (and therefore can never collide) — such runs are gated
   *  on resources only. */
  repoPaths: string[]
  cost: number
  reason: QueueReason
  /** Performs the real launch (envset, worktrees, orchestrator, kickoff +
   *  registry.set). Must register the orchestrator synchronously before
   *  resolving so the next fit() sees the new active run. */
  launch: () => Promise<void>
}

export interface RunSchedulerDeps {
  /** Snapshot of currently running/healing runs (NOT queued ones). */
  listActive: () => SchedulerActiveRun[]
  readResources: () => SystemResources
  config: AdmissionConfig
}

export type FitResult = { ok: true } | { ok: false; reason: QueueReason }

export class RunScheduler {
  private readonly queue: QueuedRun[] = []
  private promoting = false

  constructor(private readonly deps: RunSchedulerDeps) {}

  /** Can a candidate start right now? Collision takes priority over the
   *  resource budget so the queue reason reflects the real blocker. */
  fits(candidate: { repoPaths: string[]; cost: number }): FitResult {
    const active = this.deps.listActive()
    if (detectRepoCollision(candidate.repoPaths, active)) {
      return { ok: false, reason: 'repo-collision' }
    }
    const decision = decideAdmission({
      activeCosts: active.map((a) => a.cost),
      candidateCost: candidate.cost,
      resources: this.deps.readResources(),
      config: this.deps.config,
    })
    return decision.admit ? { ok: true } : { ok: false, reason: 'resources' }
  }

  enqueue(run: QueuedRun): void {
    this.queue.push(run)
  }

  queued(): readonly QueuedRun[] {
    return this.queue
  }

  isQueued(runId: string): boolean {
    return this.queue.some((q) => q.runId === runId)
  }

  /** Remove a queued run (e.g. user aborts it before it starts). */
  cancel(runId: string): boolean {
    const i = this.queue.findIndex((q) => q.runId === runId)
    if (i === -1) return false
    this.queue.splice(i, 1)
    return true
  }

  /**
   * Promote as many fitting queued runs as capacity allows, FIFO. Re-entrancy-
   * guarded so overlapping run-end events can't double-launch. After each
   * launch the active set has changed, so evaluation restarts from the top.
   */
  async promote(): Promise<void> {
    if (this.promoting) return
    this.promoting = true
    try {
      let launched = true
      while (launched) {
        launched = false
        for (let i = 0; i < this.queue.length; i += 1) {
          const item = this.queue[i]
          if (!this.fits({ repoPaths: item.repoPaths, cost: item.cost }).ok) continue
          this.queue.splice(i, 1)
          await item.launch().catch(() => {})
          launched = true
          break
        }
      }
    } finally {
      this.promoting = false
    }
  }
}
