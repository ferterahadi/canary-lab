// The sabotage phase: break the app once in a staging worktree, gate on the
// test files staying untouched (no-cheat), then freeze the broken state to a
// commit SHA and capture the replayable diff.
//
// We deliberately do NOT boot services + run the suite here to confirm the
// break landed. That validity check is redundant: every arm's first action in
// the race is an unhealed run against this same frozen state, so a no-op
// sabotage (the edit broke no test) surfaces there — in the exact harness the
// race uses — and aborts the benchmark as invalid (see race.ts). Skipping the
// in-phase trial removes a full service-boot + full-suite cycle from every
// benchmark, so the UI leaves the Sabotage stage as soon as the agent + freeze
// finish instead of blocking on a hidden trial run. The empty-diff guard in
// freeze() still catches an agent that edited nothing, for free.
//
// Pure control flow with injected git/agent ops so it's unit-testable without
// real worktrees or agents. The real deps are wired by BenchmarkOrchestrator.

export interface SabotageDeps {
  /** Create the staging worktree from the feature repo; return its path. */
  createStagingWorktree: () => Promise<string>
  /** Run the sabotage agent against the worktree with the skill recipe. */
  runSabotageAgent: (worktreePath: string, recipe: string) => Promise<void>
  /** True when no test files were modified by the agent (no-cheat). */
  testsUntouched: (worktreePath: string) => Promise<boolean>
  /** Commit the broken state; return the sabotage SHA. Throws if nothing changed. */
  freeze: (worktreePath: string) => Promise<string>
  /** Capture the frozen diff (replayable/auditable). */
  captureDiff: (worktreePath: string) => Promise<string>
  /** When it returns true, abort the sabotage promptly (Stop pressed) — the
   *  caller treats the throw as 'aborted'. */
  isAborted?: () => boolean
}

export interface SabotageResult {
  sabotageSha: string
  diff: string
  worktreePath: string
}

export async function runSabotage(
  recipe: string,
  deps: SabotageDeps,
): Promise<SabotageResult> {
  const worktreePath = await deps.createStagingWorktree()
  if (deps.isAborted?.()) throw new Error('Sabotage aborted')

  await deps.runSabotageAgent(worktreePath, recipe)
  // The agent child is killed on abort → resolves here → bail before freezing.
  if (deps.isAborted?.()) throw new Error('Sabotage aborted')

  if (!(await deps.testsUntouched(worktreePath))) {
    throw new Error(
      'Sabotage modified test files (no-cheat violation): the sabotage agent may only edit app/service code.',
    )
  }

  const sabotageSha = await deps.freeze(worktreePath)
  const diff = await deps.captureDiff(worktreePath)
  return { sabotageSha, diff, worktreePath }
}
