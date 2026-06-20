import type { BenchmarkManifest } from './types'
import type { ArmIterationResult, BenchmarkReport } from './report'
import { SabotageNoopError } from './race'

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
  /** Create the two arm worktrees checked out at the sabotage SHA. Returns each
   *  arm's worktree root so the manifest can expose it (the UI opens it in the
   *  user's editor to watch healing live). */
  setupArms: (sabotageSha: string) => Promise<Partial<Record<'A' | 'B', string>>>
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

    // Stop signal can arrive at any phase. We bail at each boundary and skip the
    // streaming persists once aborted, so a Stop reflects promptly and nothing
    // overwrites the 'aborted' state the runner optimistically wrote.
    const finalizeAborted = (): BenchmarkManifest => {
      m = { ...m, status: 'aborted', endedAt: d.now() }
      d.persist(m)
      return m
    }

    try {
      const { sabotageSha, diff } = await d.sabotage()
      if (d.isAborted?.()) return finalizeAborted()
      d.writeDiff(diff)
      m = { ...m, sabotageSha, status: 'running' }
      d.persist(m)

      const armPaths = (await d.setupArms(sabotageSha)) ?? {}
      if (d.isAborted?.()) return finalizeAborted()
      // Record each arm's worktree root so the UI can open it in the editor.
      m = {
        ...m,
        arms: m.arms.map((a) => (armPaths[a.arm] ? { ...a, worktreePath: armPaths[a.arm] } : a)),
      }
      d.persist(m)

      const report = await d.runRace({
        sabotageSha,
        onArmStart: (arm, iteration, runId) => {
          if (d.isAborted?.()) return
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
          if (d.isAborted?.()) return
          m = { ...m, results: [...m.results, result], currentIteration: result.iteration }
          d.persist(m)
        },
        onIterationComplete: (iteration) => {
          if (d.isAborted?.()) return
          m = { ...m, currentIteration: iteration }
          d.persist(m)
        },
      })

      m = { ...m, status: d.isAborted?.() ? 'aborted' : 'done', endedAt: d.now(), report }
      d.persist(m)
    } catch (err) {
      // A Stop that interrupts a phase surfaces as a throw — record it as
      // 'aborted', not 'error'. A no-op sabotage (the race found the frozen
      // edit broke nothing) is 'invalid' — a clean "re-run" outcome, not a
      // crash. Everything else is a real 'error'.
      if (d.isAborted?.()) {
        m = { ...m, status: 'aborted', endedAt: d.now() }
      } else if (err instanceof SabotageNoopError) {
        m = { ...m, status: 'invalid', error: err.message, endedAt: d.now() }
      } else {
        m = { ...m, status: 'error', error: err instanceof Error ? err.message : String(err), endedAt: d.now() }
      }
      d.persist(m)
    } finally {
      await d.cleanup?.()
    }

    return m
  }
}
