---
description: Self-heal the most recent Playwright failure
---

The canary-lab runner spawned you because Playwright just failed. Diagnose it, fix the code, signal the runner, exit. Do not wait for user input.

## Rules

- **No orientation.** Don't `ls`, don't `Glob` the tree, don't open `README.md`. The failure already names the feature.
- **No full-file reads.** `Grep` a distinctive literal from the service-log slice first, then `Read` ±20 lines at the match.
- **Service-log slice is ground truth.** `error.message` = what's wrong. The per-failure slice under `logs/failed/<slug>/<svc>.log` = where. Use both.
- **One fix per iteration.** Group failures that share evidence into one hypothesis and one edit.
- **Fix the app/service code, not the test.** Assume the test is correct. If an assertion disagrees with service output, change the service to match the assertion — never weaken or rewrite the assertion. The only exception is an obvious test-side bug (syntax error, reference to something that doesn't exist); in that case, use `.rerun` instead of `.restart`.

## Steps

1. **Preflight.** `Read logs/heal-index.md`. This is your single entry point — it lists every failure with its slice file paths and a summary of the last 3 journal iterations.
   - If `heal-index.md` doesn't exist, fall back to `Read logs/e2e-summary.json` (the runner may be running an older build). If neither exists, tell the user the runner hasn't produced a summary yet and stop. If the index exists but shows 0 failures, say "nothing to heal" and stop.
2. **Journal check.** The index already summarizes the last few iterations. If the latest has `outcome: pending`, open `logs/diagnosis-journal.json`, set that iteration's outcome based on the current index (`all_passed` / `partial` / `no_change` / `regression` — see `self-fixing-loop.md` Evaluate), then continue with a new iteration for the remaining failures. Skip hypotheses already tried.
3. **Load failure context.** The index already inlines the Playwright assertion (±8 lines around `location`) — you usually do **not** need to Read the spec file. For service-side context, Read the specific `logs/failed/<slug>/<svc>.log` slice listed under the failure. Slices are pre-scoped via XML markers and capped at ~20KB. If a slice is elided in the middle and you need more, use `sed -n '/<slug>/,/<\/slug>/p' logs/svc-<name>.log` against the full log.
4. **Locate the bug.** Pick a distinctive literal from the inlined assertion or the slice (a quoted value, a camelCase/snake_case identifier, a numeric expected value). `Grep` it inside the feature dir first, then the declared repo paths from `logs/manifest.json` (`repoPaths[]`). `Read` ±20 lines at the match.
5. **Edit.** Make the minimal fix with `Edit`. Append one entry to `logs/diagnosis-journal.json` with `feature`, `iteration`, `timestamp`, `failingTests`, `hypothesis`, `fix.file`, `fix.description`, `signal`.
6. **Signal.** Write the signal file:
   - `logs/.restart` if service code changed, `logs/.rerun` if only test/config changed.
   - Body (one JSON line): `{"hypothesis":"…","filesChanged":["…"],"expectation":"<slug-a>,<slug-b>"}`.
7. **Finish.**
   - **Auto-heal (spawned by the runner):** exit. The runner is polling and will re-run.
   - **Manual `self heal` (typed in chat):** tell the user which signal file you wrote and that the runner in their other tab will re-run; don't exit the chat.

If no slice files are listed for a failure in the index, or distinctive literals don't localize the bug, open `.claude/skills/self-fixing-loop.md` for the fallback (Step 3: sed-by-slug + instrument-first).
