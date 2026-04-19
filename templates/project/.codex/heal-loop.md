---
description: Self-heal the most recent Playwright failure
---

The canary-lab runner spawned you because Playwright just failed. Diagnose it, fix the code, signal the runner, exit. Do not wait for user input.

## Rules

- **No orientation.** Don't `ls`, don't glob the tree, don't open `AGENTS.md` / `README.md`. The failure already names the feature.
- **No full-file reads.** `rg -n` a distinctive literal from the service-log chunk first, then read ±20 lines at the match (`sed -n 'N,Mp'` or equivalent).
- **Service-log chunk is ground truth.** `error.message` = what's wrong. `failed[].logs[<svc>]` = where. Use both.
- **One fix per iteration.** Group failures that share evidence into one hypothesis and one edit.
- **Fix the app/service code, not the test.** Assume the test is correct. If an assertion disagrees with service output, change the service to match the assertion — never weaken or rewrite the assertion. The only exception is an obvious test-side bug (syntax error, reference to something that doesn't exist); in that case, use `.rerun` instead of `.restart`.

## Steps

1. **Preflight.** If `logs/e2e-summary.json` doesn't exist, tell the user the runner hasn't produced a summary yet (is `npx canary-lab run` running?) and stop. If it exists but `failed[]` is empty and the journal has a pending iteration, set that iteration's `outcome` to `"all_passed"` and report success. Otherwise say "nothing to heal" and stop.
2. If `logs/diagnosis-journal.json` exists, read it. Skip any hypothesis already tried. **If the latest iteration has `outcome: null`, set it first** based on the current summary (`all_passed` / `partial` / `no_change` / `regression` — see `self-fixing-loop.md` Evaluate). Then continue with a new iteration for the remaining failures. The runner already extracted each failing test's service-log chunk into `logs/e2e-summary.json`, so you do not need to read raw svc logs on the happy path.
3. Read `logs/e2e-summary.json`. For each `failed[]`, mentally pair `error.message` (expected) with `logs[<svc>]` (actual). The feature name is the first path segment of `failed[].location` after `features/`.
4. From each actual chunk, pick a distinctive literal (a numeric value, a `[feature]` log prefix, a variable name shared with the assertion). `rg -n` it inside `features/<feature>/scripts`, then read ±20 lines at the match. (If the feature doesn't use `scripts/`, grep the feature root.)
5. Make the minimal edit. Append one entry to `logs/diagnosis-journal.json` with `feature`, `iteration`, `timestamp`, `failingTests`, `hypothesis`, `fix.file`, `fix.description`, `signal`.
6. Write the signal file:
   - `logs/.restart` if service code changed, `logs/.rerun` if only test/config changed.
   - Body (one JSON line): `{"hypothesis":"…","filesChanged":["…"],"expectation":"<slug-a>,<slug-b>"}`.
7. Finish:
   - **Auto-heal (spawned by the runner):** exit. The runner is polling and will re-run.
   - **Manual `self heal` (typed in chat):** tell the user which signal file you wrote and that the runner in their other tab will re-run; don't exit the chat.

If `logs[<svc>]` is empty for every failure, or distinctive literals don't localize the bug, open `.codex/self-fixing-loop.md` for the fallback (Step 3: sed-by-slug on `logs/svc-*.log` + instrument-first).
