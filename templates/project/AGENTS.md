<!-- managed:canary-lab:start -->
# Canary Lab Project Notes

This managed block is refreshed by `canary-lab upgrade`.
When the user says `self heal`, follow the `heal-prompt` block below. The `logs/current` pointer tracks the active run.

<!-- heal-prompt:start -->
Playwright failed. Fix service/app code, not tests.

Run directory:
- `logs/current` (`logs/current` from the project root)

Start here:
- `logs/current/heal-index.md` — first file to read when present. It lists failed tests, assertion errors, editable repos, and exact per-failure slice paths.
- `logs/current/e2e-summary.json` — raw Playwright summary. Use only if `heal-index.md` is missing or incomplete.

Useful only when needed:
- `logs/current/failed/<slug>/trace-extract/failure-summary.md` — curated extract of the failing Playwright run. Read this FIRST for any UI failure: failing action with selector + error, accessibility snapshot at the failure moment, failed network, console errors. For deeper drill-down, every supporting file is in the SAME directory (`failing-action.txt`, `failed-actions.txt`, `snapshot-at-failure.txt`, `snapshot-before.txt`, `actions.txt`, `network-failed.txt`, `console-errors.txt`, `metadata.txt`) — use the `Read` tool on them directly. Do NOT invoke the `playwright trace` CLI; everything you need is already on disk.
- `logs/current/failed/<slug>/<svc>.log` — pre-sliced service logs referenced by `heal-index.md`.
- `logs/current/failed/<slug>/playwright-mcp/` — console logs / DOM snapshots / network captures the Playwright MCP server recorded from a re-execution of this failure. Inspect when the trace summary plus service log together still don't explain the bug, or when you need to re-drive the page.
- `logs/current/svc-<safeName>.log` — full service log. Use only if a slice is missing or too short.
- `logs/current/diagnosis-journal.md` — prior heal attempts. Use only when the current prompt or index says prior iterations exist.

<!-- personal-wiki:start -->
<!-- personal-wiki:end -->

Rules:
- Do not read the test spec unless the failure cannot be understood from the index and logs.
- Prefer exact slice paths from `heal-index.md` before broad repo search.
- After fixing, write the per-run signal file:
  - Service/app fix → `logs/current/signals/.restart`
  - Test/config-only fix → `logs/current/signals/.rerun`
- If the existing logs and snapshots don't give you a clear hypothesis, add temporary logging to the suspect service/app code and write the restart signal. The next cycle will read the new log output.
- Signal body: `{"hypothesis":"<concise diagnosis of what's wrong>","fixDescription":"<concise summary of what the fix does>"}`. Both fields land in the audit journal. The runner detects which files you changed via git — do not list them.

Make the failing Playwright tests pass on the next cycle by fixing the root cause in service/app code and writing the appropriate signal file.
<!-- heal-prompt:end -->
<!-- managed:canary-lab:end -->
