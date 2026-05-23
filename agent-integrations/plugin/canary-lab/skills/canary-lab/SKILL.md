---
name: canary-lab
description: Use when running, verifying, debugging, or healing Canary Lab features through Canary Lab MCP tools.
type: skill
---

# Canary Lab

## Workspace Bootstrap

Before calling Canary Lab MCP tools, make sure the workspace and UI server are available.

1. Read the user-level registry at `~/.canary-lab/workspaces.json`. On Windows, resolve it from the user's home directory, for example `%USERPROFILE%\.canary-lab\workspaces.json`.
2. If the registry has exactly one workspace, use that workspace. If it has multiple workspaces, list their `name` and `path` values and ask which one to use.
3. If the registry is missing or empty, ask the user to run `npx canary-lab setup` from the Canary Lab workspace.
4. Check `http://127.0.0.1:7421/mcp/health`.
5. If the health check succeeds, confirm `projectRoot` matches the selected workspace. If it points at a different workspace, ask the user whether to stop the existing Canary Lab server before continuing.
6. If the health check fails, start `npx canary-lab ui` from the selected workspace in a visible long-running terminal when the host supports that. Do not add `--port`; Canary Lab uses port `7421` so MCP clients can connect consistently.
7. Once the health check passes, call `list_features` and `list_runs` before helping the user choose what to rerun.

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
