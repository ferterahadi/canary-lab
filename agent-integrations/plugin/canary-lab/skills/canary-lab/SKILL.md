---
name: canary-lab
description: Use when running, verifying, debugging, or healing Canary Lab features through Canary Lab MCP tools.
type: skill
---

# Canary Lab

Use the Canary Lab MCP tools in this order:

1. `list_features`
2. `start_run` with `claim_heal: true`, a stable `session_id`, and `run_ref` when the user asks to rerun a specific run suffix such as `7cvh`
3. if `start_run` returns `active_heal_blocks_start`, ask whether to call `cancel_heal` on `activeRunId`; do not start a fresh or different run while a matching run is healing
4. if `start_run` returns an active run, continue it
5. `wait_for_heal_task`
6. fix application code when `needs_heal` is returned
7. `write_journal`
8. `signal_run` with `rerun` or `restart`
9. repeat from `wait_for_heal_task` until passed or terminal failure

If `start_run` or `claim_heal` says the active run is already claimed, stop and report the owning session instead of creating another run. If the user explicitly says "stop heal", call `cancel_heal`. Fix app/service code, not tests, unless the test is provably wrong. Keep the same `session_id` for the whole conversation. Call `heartbeat` with `status: "healing"` at the top of each new tool batch while fixing code — sessions auto-disconnect after 10 minutes of MCP silence, and `Read`/`Edit`/`Write`/`Bash` are not MCP calls.

`start_run` is the single entrypoint for start/resume/restart intent; a healing run has priority and blocks fresh or different starts until `cancel_heal` stops it. For requests like "rerun 7cvh", `start_run` resolves the run suffix and restarts that same failed/aborted run in remaining-test mode. Canary Lab reruns failed tests first, then skipped tests, then pending/not-run tests; do not tell the user no test filter exists. After changing code or tests, never call `start_run` to verify. Verification means `write_journal`, then `signal_run`, then `wait_for_heal_task` on the same `runId`. Do not pass `force_new` during normal healing.

When reporting run results, use `result.counts.statusLine`, `result.counts.passed`, or `summary.passed`. Never compute passed count as `summary.total - summary.failed.length`. Tests absent from `passedNames`, `failed`, and `skippedNames` are not run, not passed.
