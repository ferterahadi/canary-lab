<!-- managed:canary-lab:start -->
# Canary Lab Project Notes

This managed block is refreshed by `canary-lab upgrade`.
When the user says `self heal`, follow the `heal-prompt` block below. The `logs/current` pointer tracks the active run.

<!-- heal-prompt:start -->
Playwright failed. Fix service/app code, not tests.

Start here:
- `logs/current/heal-index.md` — first file to read when present. It lists failed tests, assertion errors, editable repos, and exact `logs/current/failed/...` slice paths.
- `logs/current/e2e-summary.json` — raw Playwright summary. Use only if `heal-index.md` is missing or incomplete.

Useful only when needed:
- `logs/current/failed/<slug>/<svc>.log` — pre-sliced service logs referenced by `heal-index.md`.
- `logs/current/failed/<slug>/playwright-mcp/` — when present, console logs / DOM snapshots / network captures the Playwright MCP server recorded for this failure. Inspect when the service log alone doesn't explain the bug.
- `logs/current/svc-<safeName>.log` — full service log. Use only if a slice is missing or too short.
- `logs/current/diagnosis-journal.md` — prior heal attempts for the active run. Use only when the current prompt or index says prior iterations exist.

Rules:
- Do not read the test spec unless the failure cannot be understood from the index and logs.
- Prefer exact slice paths from `heal-index.md` before broad repo search.
- After fixing, write the per-run signal file under `logs/current/signals/`. Use `.restart` for service/app changes or `.rerun` for test/config-only changes.
- Signal body: `{"hypothesis":"…","filesChanged":["<abs-path>", …]}`.
<!-- heal-prompt:end -->
<!-- managed:canary-lab:end -->
