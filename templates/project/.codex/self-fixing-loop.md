# Codex Self-Fixing Loop

This file extends `.codex/heal-loop.md`. Read `heal-loop.md` first for the rules and happy-path steps; open this file only when:

- `failed[].logs[<svc>]` is empty for every failure, or distinctive literals don't localize the bug → **Fallback path** below.
- You're on cycle 2+ and need the evaluation loop → **Evaluate** below.
- The user typed `self heal` manually (no auto-heal prompt was loaded) → start here, then follow `heal-loop.md` for the happy-path steps.

## Fallback path (extends Step 4 of heal-loop)

Use this only when the triangulation in `heal-loop.md` can't localize the bug.

1. **Raw log by slug.** `sed -n '/<test-case-SLUG>/,/<\/test-case-SLUG>/p' logs/svc-*.log`, with `SLUG` = `failed[].name`. Svc logs are wiped on every signal, so output is this iteration only.
2. **If `sed` is also empty — instrument, then fix.** `rg` to locate the handler, add `console.log` at decision points (inputs, branch taken, helper returns), write `.restart` with a `gather-evidence` hypothesis, and exit. On the next iteration, re-run `sed` and fix from real evidence. Remove the diagnostic logs in the same iteration that lands the fix.

## Journal format (Step 5 of heal-loop)

Append a new H2 section to `logs/diagnosis-journal.md` (create if missing). One section per iteration, covering *all* grouped failures. Markdown — not JSON — so the agent can append and re-read fluently.

```markdown
## Iteration <N> — <ISO timestamp>

- feature: <feature>
- failingTests: <slug-a>, <slug-b>
- hypothesis: <what is wrong and why>
- filesExamined: path/to/file.ts:120-140, path/to/other.ts:50-60
- fix.file: path/to/file.ts
- fix.description: <what changed>
- signal: .restart | .rerun
- outcome: pending
```

`<N>` is one higher than the highest existing iteration in the file. `outcome: pending` stays until the next cycle evaluates it (see below) — replace it with `all_passed` / `partial` / `no_change` / `regression`.

## Evaluate (used by heal-loop Step 2 on cycle 2+)

At the start of each auto-heal cycle, before forming a new hypothesis, read the updated `logs/heal-index.md` (or `logs/e2e-summary.json` as fallback) and set the **previous** iteration's `outcome` by editing its `- outcome: pending` line:

- `"all_passed"` — every slug in the prior `expectation` now passes. Tell the user, stop.
- `"partial"` — some pass, others still fail. Add a short note. Continue with a new iteration for the remaining failures.
- `"no_change"` — same failure set. Prior hypothesis was wrong; pick a different literal or handler.
- `"regression"` — new tests are failing that weren't before. Revert or adjust.

The runner stops auto-heal after 3 consecutive cycles on the same failure set. If you reach that point manually, produce a brief diagnosis report (what you tried, what you learned, suspected root cause) and ask for guidance instead of retrying.

## Manual entry (`self heal` typed in chat)

No auto-heal prompt was loaded, so start here:

1. Follow the Rules + all Steps in `.codex/heal-loop.md`.
2. If you hit the edge cases above, fall through to the Fallback path.
3. After writing the signal file, do **not** exit the chat — the user ran you manually, so report what you did and wait for the next instruction.
