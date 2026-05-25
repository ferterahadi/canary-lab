---
name: canary-lab
description: Use when the user asks Codex to run, verify, debug, heal, or iterate on Canary Lab features through the Canary Lab MCP tools. Guides Codex through list_features, start_run, wait_for_heal_task, code fixes, signal_run, and repeat-until-passing workflows.
---

# Canary Lab

Use Canary Lab MCP tools for Canary Lab runs instead of ad hoc shell commands when available.

## Workspace Bootstrap

Before calling Canary Lab MCP tools, make sure the workspace and UI server are available.

1. Read the user-level registry at `~/.canary-lab/workspaces.json`. On Windows, resolve it from the user's home directory, for example `%USERPROFILE%\.canary-lab\workspaces.json`.
2. If the registry has exactly one workspace, use that workspace. If it has multiple workspaces, list their `name` and `path` values and ask which one to use.
3. If the registry is missing or empty, ask the user to run `npx canary-lab setup` from the Canary Lab workspace.
4. Check `http://127.0.0.1:7421/mcp/health`.
5. If the health check succeeds, confirm `projectRoot` matches the selected workspace. If it points at a different workspace, ask the user whether to stop the existing Canary Lab server before continuing.
6. If the health check fails, start `npx canary-lab ui` from the selected workspace in a visible long-running terminal when the host supports that. Do not add `--port`; Canary Lab uses port `7421` so MCP clients can connect consistently.
7. Once the health check passes, call `list_features` and `list_runs` before helping the user choose what to rerun.

## External Run Loop

1. Call `list_features` and choose the requested feature.
2. Call `start_run` with `claim_heal: true`, a stable `session_id`, `client_kind: "codex-cli"` or `"codex-desktop"`, and a useful `conversation_name`. For requests like "rerun 7cvh", pass `run_ref: "7cvh"`.
3. If `start_run` returns `active_heal_blocks_start`, stop and ask whether to call `cancel_heal` on `activeRunId`. Do not start a fresh or different run while a matching run is healing.
4. If `start_run` returns an active run, continue that run.
5. If `start_run` reports `already-claimed`, stop and tell the user which session owns the run.
6. Handle user interrupts explicitly: "pause", "intercept", or "pause and heal" means call `pause_run`; "stop heal" or "cancel repair" means call `cancel_heal`; "abort", "kill the run", or "stop everything" means call `abort_run` only with the required confirmation.
7. Call `wait_for_heal_task` with the same `session_id`.
8. If it returns `passed`, summarize using `result.counts.statusLine` and stop.
9. If it returns `failed`, report the terminal status using `result.counts.statusLine` and relevant failure summary.
10. If it returns `needs_heal`, inspect `context.healPrompt.startHere` first, then use `context.healPrompt.resources`, the returned heal context, and the checked-out source code.
11. Fix app/service code, not tests, unless the test is provably wrong.
12. Call `signal_run` with `kind: "rerun"` for test-only/app-code fixes that do not need service restart, or `kind: "restart"` when services or env need restarting. Include `hypothesis` and `fixDescription`; Canary Lab writes the journal from that signal and its observed git diff.
13. Do not call a separate journal-writing tool; the runner records failing tests, changed files, signal, outcome, and diff.
14. Repeat from `wait_for_heal_task` until the run passes or reaches terminal failure.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- `heartbeat` is a low-level liveness refresh for long local repair stretches. `wait_for_heal_task` heartbeats while waiting, and `signal_run` and `get_heal_context` refresh liveness, so call explicit `heartbeat` only before or after a long stretch of local `Read` / `Edit` / `Write` / `Bash` work.
- `start_run` is the single entrypoint for start/resume/restart intent; a healing run has priority and blocks fresh or different starts until `cancel_heal` stops it.
- For requests like "rerun 7cvh", `start_run` resolves the run suffix and restarts that same failed/aborted run in remaining-test mode. Canary Lab reruns failed tests first, then skipped tests, then pending/not-run tests; do not tell the user no test filter exists.
- After changing code or tests, never call `start_run` to verify. Verification means `signal_run` with `hypothesis` and `fixDescription`, then `wait_for_heal_task` on the same `runId`.
- Do not pass `force_new` during normal healing.
- Never compute passed count as `summary.total - summary.failed.length`.
- Use `result.counts.statusLine`, `result.counts.passed`, or `summary.passed` for pass counts.
- Treat tests absent from `passedNames`, `failed`, and `skippedNames` as not run, not passed.
- Do not call `abort_run` unless the user asks, and pass the required confirmation only for an explicit abort/kill/stop-everything request.
- Prefer `get_heal_context` when you need to refresh failure artifacts outside the wait loop.
- Record concise, factual journal notes. Do not paste raw transcripts.
- When the run is waiting for external heal, Canary Lab is the source of truth for status, artifacts, and rerun/restart signals.
