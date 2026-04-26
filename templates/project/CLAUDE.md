<!-- managed:canary-lab:start -->
# Canary Lab Project Notes

This managed block is refreshed by `canary-lab upgrade`.
When the user says `self heal`, follow the `heal-prompt` block below.

<!-- heal-prompt:start -->
Playwright failed. Fix service/app code, not tests.

Start here:
- `logs/heal-index.md` — first file to read when present. It lists failed tests, assertion errors, editable repos, and exact `logs/failed/...` slice paths.
- `logs/e2e-summary.json` — raw Playwright summary. Use only if `heal-index.md` is missing or incomplete.

Useful only when needed:
- `logs/failed/<slug>/<svc>.log` — pre-sliced service logs referenced by `heal-index.md`.
- `logs/svc-<name>.log` — full service log. Use only if a slice is missing or too short.
- `logs/diagnosis-journal.md` — prior heal attempts. Use only when the current prompt or index says prior iterations exist.
- `logs/signal-history.json` — signal history. Rarely needed.

Rules:
- Do not read the test spec unless the failure cannot be understood from the index and logs.
- Prefer exact slice paths from `heal-index.md` before broad repo search.
- After fixing, write `logs/.restart` for service/app changes or `logs/.rerun` for test/config-only changes.
- Signal body: `{"hypothesis":"…","filesChanged":["<abs-path>", …]}`.
<!-- heal-prompt:end -->
<!-- managed:canary-lab:end -->
