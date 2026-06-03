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
}

/**
 * A minimal heal-prompt builder for the baseline arm: the agent is told the
 * tests fail and to fix the app/service code, with only Playwright's own tools
 * (`npx playwright test` + the Playwright MCP) — none of Canary Lab's curated
 * failure context. Mirrors `buildOrchestratorHealPrompt`'s contract (returns the
 * text and persists it to `heal-prompt.md`).
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
      'When you have a fix in place, write the rerun signal (or restart if services / env must restart) by calling `signal_run`.',
    ].join('\n\n')
    fs.mkdirSync(path.dirname(promptFile), { recursive: true })
    fs.writeFileSync(promptFile, prompt)
    return prompt
  }
}
