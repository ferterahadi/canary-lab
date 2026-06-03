import type { BenchmarkManifest } from './types'
import type { ArmIterationResult, BenchmarkReport } from './report'

// Sequences the full benchmark lifecycle and owns the manifest as the source of
// truth, persisting on every transition (which is also the WS push point).
// All I/O — sabotage, arm setup, the race, timestamps — is injected, so the
// lifecycle + persistence contract is unit-testable. The real deps (git
// worktrees, sabotage agent, RunOrchestrator-driven arms) are wired by the
// server factory.

export interface RaceContext {
  sabotageSha: string
  onResult: (result: ArmIterationResult) => void
  onIterationComplete: (iteration: number) => void
  /** An arm's run was created — record its runId + persist so the UI can attach
   *  the live run panel before the arm finishes. */
  onArmStart: (arm: 'A' | 'B', iteration: number, runId: string) => void
}

export interface BenchmarkOrchestratorDeps {
  /** Initial manifest (status 'sabotaging'). */
  manifest: BenchmarkManifest
  /** Write the manifest + emit the WS update. Called on every transition. */
  persist: (manifest: BenchmarkManifest) => void
  /** Break the app once, validate, freeze. Returns the frozen SHA + diff. */
  sabotage: () => Promise<{ sabotageSha: string; diff: string }>
  /** Persist the frozen sabotage diff artifact. */
  writeDiff: (diff: string) => void
  /** Create the two arm worktrees checked out at the sabotage SHA. */
  setupArms: (sabotageSha: string) => Promise<void>
  /** Run the parallel-arms race; stream results back via the callbacks. */
  runRace: (ctx: RaceContext) => Promise<BenchmarkReport>
  /** ISO timestamp source (injected for determinism in tests). */
  now: () => string
  /** True when the run was aborted — final status becomes 'aborted', not 'done'. */
  isAborted?: () => boolean
  /** Best-effort teardown (remove worktrees, etc.). Always runs. */
  cleanup?: () => Promise<void>
}

export class BenchmarkOrchestrator {
  constructor(private readonly deps: BenchmarkOrchestratorDeps) {}

  async run(): Promise<BenchmarkManifest> {
    const d = this.deps
    let m: BenchmarkManifest = { ...d.manifest, status: 'sabotaging' }
    d.persist(m)

    try {
      const { sabotageSha, diff } = await d.sabotage()
      d.writeDiff(diff)
      m = { ...m, sabotageSha, status: 'running' }
      d.persist(m)

      await d.setupArms(sabotageSha)

      const report = await d.runRace({
        sabotageSha,
        onArmStart: (arm, iteration, runId) => {
          m = {
            ...m,
            currentIteration: Math.max(m.currentIteration, iteration),
            arms: m.arms.map((a) =>
              a.arm === arm && !a.runIds.includes(runId)
                ? { ...a, runIds: [...a.runIds, runId] }
                : a,
            ),
          }
          d.persist(m)
        },
        onResult: (result) => {
          m = { ...m, results: [...m.results, result], currentIteration: result.iteration }
          d.persist(m)
        },
        onIterationComplete: (iteration) => {
          m = { ...m, currentIteration: iteration }
          d.persist(m)
        },
      })

      m = { ...m, status: d.isAborted?.() ? 'aborted' : 'done', endedAt: d.now(), report }
      d.persist(m)
    } catch (err) {
      m = { ...m, status: 'error', error: err instanceof Error ? err.message : String(err), endedAt: d.now() }
      d.persist(m)
    } finally {
      await d.cleanup?.()
    }

    return m
  }
}
