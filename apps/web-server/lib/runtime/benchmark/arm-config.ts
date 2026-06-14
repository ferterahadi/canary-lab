import fs from 'fs'
import path from 'path'
import type { BuildHealCyclePrompt } from '../auto-heal'
import type { PlaywrightSpawner } from '../orchestrator'

// The harness-vs-baseline knob. Both arms run the SAME agent + model + Playwright
// MCP; the ONLY differences are (1) whether the failure-evidence enrichment runs
// and (2) which heal prompt the agent receives.
//
//   harness  → full enrichment (sliced logs, trace-extracts, journal, heal-index)
//              + the rich buildOrchestratorHealPrompt.
//   baseline → enrichment stripped + a minimal "fix the app" prompt.
//
// The enrichment is gated by `CANARY_LAB_BENCHMARK_MODE=baseline`, read by the
// summary reporter — which runs INSIDE the Playwright child process. So the flag
// must live in that child's env, NOT the orchestrator's process.env (which is
// shared by both parallel arms). We achieve per-child isolation by wrapping the
// injectable PlaywrightSpawner to prepend the env var to the shell command.

/**
 * Wrap a PlaywrightSpawner so the baseline arm's Playwright child runs with
 * `CANARY_LAB_BENCHMARK_MODE=baseline`. Parallel-safe: the var is scoped to that
 * single child process, never the shared orchestrator process.env.
 */
export function baselinePlaywrightSpawner(base: PlaywrightSpawner): PlaywrightSpawner {
  return (args) => {
    const inv = base(args)
    return { ...inv, command: `CANARY_LAB_BENCHMARK_MODE=baseline ${inv.command}` }
  }
}

export interface BaselineHealPromptOptions {
  /** Per-run dir — the prompt is persisted to <runDir>/heal-prompt.md so the
   *  spawn command's `@<promptFile>` positional reads it, same as the harness. */
  runDir: string
  /** Absolute path of the `.restart` completion-signal file. Lives in the
   *  agent's own worktree (not the run dir) so the baseline agent is never
   *  handed a path into the harness-only run dir. */
  restartSignal: string
  /** Absolute path of the `.rerun` completion-signal file (worktree-local). */
  rerunSignal: string
}

/**
 * A minimal heal-prompt builder for the baseline arm: the agent is told the
 * tests fail and to fix the app/service code, with only Playwright's own tools
 * (`npx playwright test` + the Playwright MCP) — none of Canary Lab's curated
 * failure context. Mirrors `buildOrchestratorHealPrompt`'s contract (returns the
 * text and persists it to `heal-prompt.md`).
 *
 * It DOES get the same completion-signal mechanism as the harness — empty
 * `.restart` / `.rerun` files the orchestrator watches. Without this, baseline
 * could fix the code but never tell the orchestrator it was done, so every cycle
 * stalled until the 5-min idle timeout. The benchmark's differentiator is the
 * curated failure *context*, not knowledge of the signal protocol — both arms
 * must be able to close the loop.
 *
 * The signal paths are worktree-local (see runner.ts), NOT under the run dir, so
 * pointing the baseline agent at them never reveals the harness-only run-dir
 * artifacts (`e2e-summary.json`, `svc-*.log`, sliced logs, trace-extracts).
 */
export function buildBaselineHealPrompt(
  opts: BaselineHealPromptOptions,
): BuildHealCyclePrompt {
  const promptFile = path.join(opts.runDir, 'heal-prompt.md')
  return () => {
    const prompt = [
      'The Playwright end-to-end tests for this app are failing.',
      'Fix the application / service code so the tests pass.',
      'Do NOT edit the test files — the tests are the fixed specification.',
      'Reproduce with `npx playwright test` and inspect the browser trace via the Playwright MCP tools as needed.',
      [
        'When you have a fix in place, signal completion by writing an empty signal file:',
        `- Service/app or runtime fix → \`${opts.restartSignal}\``,
        `- Test/config-only fix → \`${opts.rerunSignal}\``,
      ].join('\n'),
    ].join('\n\n')
    fs.mkdirSync(path.dirname(promptFile), { recursive: true })
    fs.writeFileSync(promptFile, prompt)
    return prompt
  }
}
