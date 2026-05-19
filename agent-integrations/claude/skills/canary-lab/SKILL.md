---
name: canary-lab
description: Use when running, verifying, debugging, or healing Canary Lab features through Canary Lab MCP tools. Teaches the external loop with list_features, start_run, wait_for_heal_task, source-code fixes, write_journal, signal_run, and repeat until the run passes.
type: skill
---

# Canary Lab

Use Canary Lab MCP tools for Canary Lab runs instead of ad hoc shell commands when available.

## External Run Loop

1. Call `list_features` and choose the requested feature.
2. Call `start_run` with `claim_heal: true`, a stable `session_id`, `client_kind: "claude-cli"` or `"claude-desktop"`, and a useful `conversation_name`. For requests like "rerun 7cvh", pass `run_ref: "7cvh"`.
3. If `start_run` returns `active_heal_blocks_start`, stop and ask whether to call `cancel_heal` on `activeRunId`. Do not start a fresh or different run while a matching run is healing.
4. If `start_run` returns an active run, continue that run.
5. If `start_run` or `claim_heal` reports `already-claimed`, stop and tell the user which session owns the run.
6. If the user explicitly says "stop heal", call `cancel_heal`.
7. Call `wait_for_heal_task` with the same `session_id`.
8. If it returns `passed`, summarize using `result.counts.statusLine` and stop.
9. If it returns `failed`, report the terminal status using `result.counts.statusLine` and relevant failure summary.
10. If it returns `needs_heal`, inspect the returned heal context and the checked-out source code.
11. Fix app/service code, not tests, unless the test is provably wrong.
12. Call `write_journal` with what was diagnosed and changed.
13. Call `signal_run` with `kind: "rerun"` for test-only/app-code fixes that do not need service restart, or `kind: "restart"` when services or env need restarting. Include `files_changed`.
14. Repeat from `wait_for_heal_task` until the run passes or reaches terminal failure.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Call `heartbeat` with `status: "healing"` at the top of each new tool batch while you are actively fixing code. Sessions auto-disconnect after 10 minutes of MCP silence — `Read`/`Edit`/`Write`/`Bash` are not MCP calls and do not refresh liveness. `signal_run`, `write_journal`, and `get_heal_context` also refresh liveness, so explicit `heartbeat` is only needed when a long stretch of local tool use is expected before the next of those.
- `start_run` is the single entrypoint for start/resume/restart intent; a healing run has priority and blocks fresh or different starts until `cancel_heal` stops it.
- For requests like "rerun 7cvh", `start_run` resolves the run suffix and restarts that same failed/aborted run in remaining-test mode. Canary Lab reruns failed tests first, then skipped tests, then pending/not-run tests; do not tell the user no test filter exists.
- After changing code or tests, never call `start_run` to verify. Verification means `write_journal`, then `signal_run`, then `wait_for_heal_task` on the same `runId`.
- Do not pass `force_new` during normal healing.
- Never compute passed count as `summary.total - summary.failed.length`.
- Use `result.counts.statusLine`, `result.counts.passed`, or `summary.passed` for pass counts.
- Treat tests absent from `passedNames`, `failed`, and `skippedNames` as not run, not passed.
- Do not call `abort_run` unless the user asks or the run is clearly unrecoverable.
- Prefer `get_heal_context` when you need to refresh failure artifacts outside the wait loop.
- Record concise, factual journal notes. Do not paste raw transcripts.
- When the run is waiting for external heal, Canary Lab is the source of truth for status, artifacts, and rerun/restart signals.
