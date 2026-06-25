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
4. Check the MCP health endpoint `/mcp/health` on the UI's port. The port defaults to `7421`, but a project may pin its own in `canary-lab.config.json`; if `7421` does not respond, run `npx canary-lab mcp doctor` to discover the active URL.
5. If the health check succeeds, confirm `projectRoot` matches the selected workspace. If it points at a different workspace, ask the user whether to stop the existing Canary Lab server before continuing.
6. If the health check fails, start `npx canary-lab ui` from the selected workspace in a visible long-running terminal when the host supports that. The port comes from `canary-lab.config.json` (default `7421`); do not pass `--port` (it was removed).
7. Do not reflexively call `list_features` or `list_runs` after health. For random or new feature creation, call `create_feature` directly with a unique feature name. Use `list_features` only when you need to discover or choose an existing feature, and use `list_runs` only for run, heal, verification, or export workflows.

For random or new feature creation, call `create_feature` directly with a unique feature name. Do not call `list_features` just to avoid collisions; if the chosen name already exists, retry `create_feature` with a different unique name.

Use the Canary Lab MCP tools in this order:

1. `list_features`
2. `start_run` with `claim_heal: true`, a stable `session_id`, and `run_ref` when the user asks to rerun a specific run suffix such as `7cvh`
3. if `start_run` returns `type: "repo_collision_requires_choice"`, another run uses the same app/repo — ask the user to run isolated in a per-run git worktree (concurrent) or queue until the other finishes, then re-call `start_run` with `isolation: "worktree"` or `isolation: "queue"`; if it returns `queued: true`, the run is parked (`queueReason`) and starts automatically — `wait_for_heal_task` still blocks until it starts
4. if `start_run` returns an active run, continue it — but if it returns `type: "boot_session"` (or `executionType: "boot"`), the run is a held boot-only session with no tests and no heal task; do not claim heal or call `wait_for_heal_task`, just report services are up and that `abort_run` (confirm:true) stops them. A service that fails its readiness probe is marked failed (status `timeout`) but the session stays held — boot does not self-abort on a health-check failure; report which came up and which failed
5. `wait_for_heal_task` — blocks a short bounded window; if it returns `type: "still_waiting"` (not terminal), call it again, looping until `needs_heal`/`passed`/`failed` (if it ever returns `type: "boot_session"`, report services are up and stop — do not wait again)
6. when `needs_heal` is returned, treat the returned heal context as the compact first-stop packet: inspect `context.healPrompt.startHere` first (`context.healIndex`/`context.journal` are paths to `Read`; each `failedTests[]` has a `failureId` + pointer dirs), then use `context.healPrompt.resources`, current failures, and the checked-out source code; call `get_run_snapshot` only for verbose debugging. `context.healPrompt`/`context.nextSteps` ship on the first `needs_heal` only — on later cycles reuse them or call `get_heal_context` to re-fetch. If the same tests fail 3+ cycles, `context.escalation` appears — change tactic per its `readFirst`/`tactics`, don't repeat the last fix. When several tests fail, fan out one read-only sub-agent per failure (each calls `get_failure_detail(runId, failureId)` and reports a hypothesis + fix; sub-agents don't edit or signal), then apply the fixes yourself
7. `signal_run` **once** per cycle with `rerun` or `restart`, including `hypothesis` and `fixDescription`
8. repeat from `wait_for_heal_task` (looping on `still_waiting`) until passed or terminal failure

If `start_run` says the active run is already claimed, stop and report the owning session instead of creating another run. Handle user interrupts explicitly: "pause", "intercept", or "pause and heal" means call `pause_run`; "stop heal" or "cancel repair" means call `cancel_heal`; "abort", "kill the run", or "stop everything" means call `abort_run` only with the required confirmation. Fix app/service code, not tests, unless the test is provably wrong. Keep the same `session_id` for the whole conversation. `heartbeat` is a low-level liveness refresh for long local repair stretches; `wait_for_heal_task`, `signal_run`, and `get_heal_context` usually refresh liveness without an explicit heartbeat call.

`start_run` is the single entrypoint for start/resume/restart intent. With no `run_ref`/`force_new`, a healing run for the feature is continued by default; concurrent runs are allowed, so a same-app collision returns `repo_collision_requires_choice` (resolve with `isolation: "worktree"` or `"queue"`) and a run over the resource budget is `queued` and starts automatically. For requests like "rerun 7cvh", `start_run` resolves the run suffix and restarts that same failed/aborted run in remaining-test mode. Canary Lab reruns failed tests first, then skipped tests, then pending/not-run tests; do not tell the user no test filter exists. Prefer this rerun over `abort_run` + a fresh start: rerun re-runs only failed/skipped/pending, while a fresh run re-runs everything and is only worth it when prior passes are invalidated. After changing code or tests, never call `start_run` to verify. Verification means `signal_run` with `hypothesis` and `fixDescription`, then `wait_for_heal_task` on the same `runId`. Use `force_new` only when the user explicitly wants a separate concurrent run on the same feature.

When reporting run results, use `result.counts.statusLine`, `result.counts.passed`, or `summary.passed`. Never compute passed count as `summary.total - summary.failed.length`. Tests absent from `passedNames`, `failed`, and `skippedNames` are not run, not passed.

Read responses are slim by default to protect context, but the full data is one step away (never poll it in a wait loop): `get_run` omits the raw `lifecycleEvents`/`playwrightArtifacts`/`playbackEvents` — call it again with `includeRaw:true` to inline them; `get_run_snapshot` returns the heal-index and journal as paths to `Read`; `list_runs` returns the newest 20 (raise `limit`).
