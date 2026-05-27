---
name: canary-lab
description: Use when running, verifying, debugging, healing, creating, or exporting Canary Lab features through Canary Lab MCP tools. Teaches external run repair plus author workflows with create_feature, env capture, external draft apply, and evaluation export.
type: skill
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
2. Call `start_run` with `claim_heal: true`, a stable `session_id`, `client_kind: "claude-cli"` or `"claude-desktop"`, and a useful `conversation_name`. For requests like "rerun 7cvh", pass `run_ref: "7cvh"`.
3. If `start_run` returns `active_heal_blocks_start`, stop and ask whether to call `cancel_heal` on `activeRunId`. Do not start a fresh or different run while a matching run is healing.
4. If `start_run` returns an active run, continue that run.
5. If `start_run` reports `already-claimed`, stop and tell the user which session owns the run.
6. Handle user interrupts explicitly: "pause", "intercept", or "pause and heal" means call `pause_run`; "stop heal" or "cancel repair" means call `cancel_heal`; "abort", "kill the run", or "stop everything" means call `abort_run` only with the required confirmation.
7. Call `wait_for_heal_task` with the same `session_id`.
8. If it returns `passed`, summarize using `result.counts.statusLine` and stop.
9. If it returns `failed`, report the terminal status using `result.counts.statusLine` and relevant failure summary.
10. If it returns `needs_heal`, treat the returned heal context as the compact first-stop packet: inspect `context.healPrompt.startHere` first, then use `context.healPrompt.resources`, current failures, and the checked-out source code. Call `get_run_snapshot` only when you need the verbose raw summary, full counts, or deeper debugging fields.
11. Fix app/service code, not tests, unless the test is provably wrong.
12. Call `signal_run` with `kind: "rerun"` for test-only/app-code fixes that do not need service restart, or `kind: "restart"` when services or env need restarting. Include `hypothesis` and `fixDescription`; Canary Lab writes the journal from that signal and its observed git diff.
13. Do not call a separate journal-writing tool; the runner records failing tests, changed files, signal, outcome, and diff.
14. Repeat from `wait_for_heal_task` until the run passes or reaches terminal failure.

## External Authoring Workflow

Use the MCP `author` profile, or `full`, when the user asks to create a feature, preserve env files, add test cases, or export a completed run as an evaluation. Canary Lab is the control plane and artifact store; this client writes the test cases and report content.

### Create or Extend a Feature

1. For a new feature, call `create_feature`. It creates the skeleton files and returns test-file rules, envset schema, and next-step tool hints. Do not manually invent a partial scaffold.
2. If the user asks to preserve existing `.env`, `.env.dev`, `application.properties`, or similar repo config files, inspect the source repo enough to identify the files, then call `capture_feature_env_files`. Do not paste secret values into chat; Canary Lab returns redacted previews only.
3. Author or edit specs under `features/<feature>/e2e/`.
4. Specs must import:
   ```ts
   import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
   ```
5. Call `start_external_draft` with a stable `session_id`, `client_kind: "claude-cli"` or `"claude-desktop"`, and a useful `conversation_name`.
6. Call `update_external_draft_stage` as work progresses: `scaffolding`, `authoring-tests`, `validating`, `ready`, `applied`, or `error`.
7. Call `apply_external_draft` with the externally authored files, or after writing them locally, so Canary Lab validates and records the applied draft. Do not ask Canary Lab to spawn another Claude/Codex agent for MCP-created authoring.

### Export an Evaluation

1. After the relevant run is terminal (passed, failed, or aborted), call `start_external_evaluation_export` with the run id and requested language. If the user asks to export a failed or aborted run as-is, preserve that status in the report instead of trying to heal first.
2. Use the returned schema to write the evaluation report or archive in this client.
3. Call `submit_external_evaluation_export` with the generated files or archive.
4. Use `get_evaluation_export`, `list_evaluation_exports`, or `download_evaluation_export` for status and download. Canary Lab stores the artifact, but it does not rewrite, translate, or generate the report with an internal agent for external exports.

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
- Prefer compact `get_heal_context` when you need to refresh failure artifacts outside the wait loop. Use `get_run_snapshot` only for verbose fallback/debugging context.
- Record concise, factual journal notes. Do not paste raw transcripts.
- When the run is waiting for external heal, Canary Lab is the source of truth for status, artifacts, and rerun/restart signals.
