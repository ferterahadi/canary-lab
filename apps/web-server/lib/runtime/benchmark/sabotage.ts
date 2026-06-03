// The sabotage phase: break the app once in a staging worktree, gate on the
// tests actually going red (and the test files staying untouched — no-cheat),
// then freeze the broken state to a commit SHA and capture the replayable diff.
//
// Pure control flow with injected git/agent/test ops so it's unit-testable
// without real worktrees or agents. The real deps are wired by
// BenchmarkOrchestrator.

export interface SabotageDeps {
  /** Create the staging worktree from the feature repo; return its path. */
  createStagingWorktree: () => Promise<string>
  /** Run the sabotage agent against the worktree with the skill recipe. */
  runSabotageAgent: (worktreePath: string, recipe: string) => Promise<void>
  /** True when no test files were modified by the agent (no-cheat). */
  testsUntouched: (worktreePath: string) => Promise<boolean>
  /** Run the feature's tests once; true when they FAIL (the break landed). */
  testsFail: (worktreePath: string) => Promise<boolean>
  /** Discard the worktree's changes back to the clean baseline (for retries). */
  resetWorktree: (worktreePath: string) => Promise<void>
  /** Commit the broken state; return the sabotage SHA. */
  freeze: (worktreePath: string) => Promise<string>
  /** Capture the frozen diff (replayable/auditable). */
  captureDiff: (worktreePath: string) => Promise<string>
  /** Re-sabotage attempts before giving up. Default 2. */
  maxAttempts?: number
}

export interface SabotageResult {
  sabotageSha: string
  diff: string
  attempts: number
  worktreePath: string
}

export async function runSabotage(
  recipe: string,
  deps: SabotageDeps,
): Promise<SabotageResult> {
  const maxAttempts = deps.maxAttempts ?? 2
  const worktreePath = await deps.createStagingWorktree()

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await deps.runSabotageAgent(worktreePath, recipe)

    if (!(await deps.testsUntouched(worktreePath))) {
      throw new Error(
        'Sabotage modified test files (no-cheat violation): the sabotage agent may only edit app/service code.',
      )
    }

    if (await deps.testsFail(worktreePath)) {
      const sabotageSha = await deps.freeze(worktreePath)
      const diff = await deps.captureDiff(worktreePath)
      return { sabotageSha, diff, attempts: attempt, worktreePath }
    }

    if (attempt < maxAttempts) await deps.resetWorktree(worktreePath)
  }

  throw new Error(
    `Sabotage failed to break the tests after ${maxAttempts} attempt(s): the tests never went red.`,
  )
}
