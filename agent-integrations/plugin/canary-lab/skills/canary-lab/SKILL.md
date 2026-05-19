---
name: canary-lab
description: Use when running, verifying, debugging, or healing Canary Lab features through Canary Lab MCP tools.
type: skill
---

# Canary Lab

Use the Canary Lab MCP tools in this order:

1. `list_features`
2. `list_runs` for the feature
3. if there is an active `running` or `healing` run, `get_run` and `claim_heal` for that run
4. only `start_run` with `claim_heal: true` as the initial entrypoint when no active run exists or when you do not yet know a `runId`
5. `wait_for_heal_task`
6. fix application code when `needs_heal` is returned
7. `write_journal`
8. `signal_run` with `rerun` or `restart`
9. repeat from `wait_for_heal_task` until passed or terminal failure

If `claim_heal` says the active run is already claimed, stop and report the owning session instead of creating another run. Fix app/service code, not tests, unless the test is provably wrong. Keep the same `session_id` for the whole conversation. Call `heartbeat` with `status: "healing"` at the top of each new tool batch while fixing code — sessions auto-disconnect after 10 minutes of MCP silence, and `Read`/`Edit`/`Write`/`Bash` are not MCP calls.

After changing code or tests, never call `start_run` to verify. Verification means `write_journal`, then `signal_run`, then `wait_for_heal_task` on the same `runId`. Do not pass `force_new` during normal healing. If `start_run` returns `ignoredForceNew`, continue the returned run with `signal_run`.

When reporting run results, use `result.counts.statusLine`, `result.counts.passed`, or `summary.passed`. Never compute passed count as `summary.total - summary.failed.length`. Tests absent from `passedNames`, `failed`, and `skippedNames` are not run, not passed.
