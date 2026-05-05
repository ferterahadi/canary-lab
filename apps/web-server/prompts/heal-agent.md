Playwright failed. Fix service/app code, not tests.

Run directory:
- `{{runDir}}` (`{{runDirRel}}` from the project root)

Start here:
- `{{healIndexPath}}` — first file to read when present. It lists failed tests, assertion errors, editable repos, and exact per-failure slice paths.
- `{{summaryPath}}` — raw Playwright summary. Use only if `heal-index.md` is missing or incomplete.

Useful only when needed:
- `{{failedDir}}/<slug>/<svc>.log` — pre-sliced service logs referenced by `heal-index.md`.
- `{{failedDir}}/<slug>/playwright-mcp/` — when present, console logs / DOM snapshots / network captures the Playwright MCP server recorded for this failure. Inspect when the service log alone does not explain the bug.
- `{{runDir}}/svc-<safeName>.log` — full service log. Use only if a slice is missing or too short.
- `{{journalPath}}` — prior heal attempts. Use only when the current prompt or index says prior iterations exist.

Rules:
- Do not read the test spec unless the failure cannot be understood from the index and logs.
- Prefer exact slice paths from `heal-index.md` before broad repo search.
- After fixing, write the per-run signal file:
  - Service/app fix → `{{restartSignal}}`
  - Test/config-only fix → `{{rerunSignal}}`
- Signal body: `{"hypothesis":"...","filesChanged":["<abs-path>", ...]}`.
