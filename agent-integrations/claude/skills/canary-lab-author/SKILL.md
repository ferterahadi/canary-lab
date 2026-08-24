---
name: canary-lab-author
description: Use when creating or extending a Canary Lab feature by hand — "create a feature for X", "add test cases to <feature>", "capture the env files", "switch the feature's branch" — through the author MCP tools (create_feature, capture_feature_env_files, write_envset, start/update/apply_external_draft, get_feature_repo_status, checkout_feature_repo_branch). For docs/PRD/coverage use canary-lab-coverage; for full onboarding of a bare repo use canary-lab (flight).
type: skill
---

# Canary Lab — Feature Authoring

This client writes the specs; Canary Lab is the control plane and artifact
store. These tools arrive via the Canary Lab MCP server. If this client is
already connected (the plugin connects with `full`), skip this step. To
configure a connection manually: `npx canary-lab mcp --profile author` (the
composite `lifecycle`/`full` profiles carry the same tools).

## Arguments

An invocation argument (`/canary-lab-author <suite>` — the Getting Started
guide's "Author Tests" card emits exactly this shape) is the name of an
EXISTING suite (feature) in the connected workspace. Follow the
**extend-an-existing-feature** path below — never `create_feature` for it,
and never rename it to dodge a collision.

## Workspace Bootstrap

1. Find the LIVE server first: read `~/.canary-lab/active-servers.json`, which records `projectRoot`, `port` and `pid` for every UI that registered. A stopped server's entry LINGERS — the file is only rewritten when the next server registers — so an entry is a candidate, not proof: the health check below is what confirms it. One entry → that is your server and its `port`. Several → take the one whose `projectRoot` is the workspace the user means. None → fall back to `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`): one workspace → use it, several → ask which, none → ask the user to run `npx canary-lab setup`. Do NOT start from a guessed port.
2. Then CONFIRM it is the right server: `curl -s http://127.0.0.1:<port>/mcp/health` and check that `projectRoot` is the workspace you intended. A healthy response does **not** settle the question on its own — a stale UI left behind by a demo or a tarball smoke test answers a port just as convincingly as the right one, and that is how a flight ends up running in someone's throwaway workspace. `projectRoot` matches what you intended → continue and tell the user which workspace. It names a DIFFERENT workspace → this is the wrong server; go back to step 1 rather than adopting it. It is under a temp directory (`/tmp`, `/private/var/folders`, `%TEMP%`) → never auto-select it; those are throwaway demo workspaces, so use one only when the user names it explicitly. Only when no live server serves the workspace you want does one need starting.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up.
4. Do not reflexively call `list_features` or `list_runs` after health. For random or new feature creation, call `create_feature` directly with a unique feature name; use `list_features` only to discover or choose an existing feature.
5. A healthy `/mcp/health` means these tools are live even when they look absent from this session. If the Canary Lab MCP tools seem missing — e.g. a tool search returns no `create_feature` match — they are usually **already loaded**: searches that index only deferred tools say nothing about loaded ones. Call `list_features` directly before concluding anything. Only if that call errors as an unknown tool is the server really not connected — ask the user to connect it (`npx canary-lab mcp`, or reconnect this client's MCP integration), then retry. Never drive `/mcp` with a hand-written HTTP/JSON-RPC client (curl included; the health check above is the only direct HTTP use): a hand-rolled client bypasses the connection's client detection, so the Canary Lab UI mis-brands the session, and it loses the session and reconnect handling these tools rely on.

## Create or Extend a Feature

1. Pick the path by what the request names:
   - **Extending an EXISTING feature** ("author tests for <feature>", "add a test for the missing behavior"): do NOT call `create_feature` — the feature and its skeleton already exist. To choose WHAT to test, `get_feature_coverage(feature)` names the untested / path-incomplete requirements (that IS the "choose a gap" step), and `list_feature_docs(feature)` points at the requirement docs behind them. Author the new spec straight into `<workspace>/features/<feature>/e2e/`, and tag it with the requirement it covers — `test('…', { tag: ['@req-R2'] }, …)` — so the gap actually closes in the coverage ledger.
   - **Creating a NEW feature**: call `create_feature` directly with a unique feature name. It creates the skeleton files and returns test-file rules, envset schema, and next-step tool hints. Do not call `list_features` just to avoid collisions; if the name you INVENTED already exists, retry `create_feature` with a different unique name — but never rename away from a feature the user asked for (that is the extending path above).
2. If the user asks to preserve existing `.env`, `.env.dev`, `application.properties`, or similar repo config files, inspect the source repo enough to identify the files, then call `capture_feature_env_files`. Do not paste secret values into chat; Canary Lab returns redacted previews only. `write_envset` fills in or corrects individual envset values (it is confirm-gated).
3. Author or edit specs under `<workspace>/features/<feature>/e2e/` — the Canary Lab WORKSPACE, not the product repo under test.
4. Specs must import:
   ```ts
   import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
   ```
5. Call `start_external_draft` with a stable `session_id` and a useful `conversation_name` (do not pass `client_kind` — the bridge auto-detects it). This only creates a visible Canary Lab task so the user sees that this external client is authoring tests; it does not start an internal wizard agent. Carry the `draftId` it returns into every subsequent `update_external_draft_stage` / `apply_external_draft` call for this draft. If it returns `type: "getting_started_busy"`, a Getting Started demo already owns the workspace — follow the active target it returns; do not start another workflow.
6. After `start_external_draft` returns, tell the user you are authoring tests and they can follow along live in the Canary Lab UI: the suite's Flight page shows this work on its Test authoring & coverage stage (that view is read-only while this client drives — it monitors, you act here). Continue writing specs locally, then call `update_external_draft_stage(draftId, stage)` as work progresses: `scaffolding`, `authoring-tests`, `validating`, `ready`, `applied`, or `error`.
7. Call `apply_external_draft` with `draftId`, `confirm: true`, and `files: [{path, content}, …]` for the externally authored files (omit `files` if you already wrote them directly under `<workspace>/features/<feature>/e2e/` — it then validates what's on disk), so Canary Lab validates and records the applied draft. Do not ask Canary Lab to spawn another Claude/Codex agent for MCP-created authoring. On a validation error, fix the named file and re-call `apply_external_draft`.
8. `get_feature_repo_status` / `checkout_feature_repo_branch` inspect and switch the feature's bound repo branches when the user asks to test a different branch.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Canary Lab never writes the test body for external authoring — this client does.
- After authoring, the natural next steps live in sibling skills: map coverage (`canary-lab-coverage`), run + heal (`canary-lab-run`), export the evaluation (`canary-lab-export`). **Running the new test** needs the run tools: on the plugin (`full`) or a default `lifecycle` connection `start_run` is already available — follow `canary-lab-run`. On a narrow `--profile author` connection it is NOT: don't conclude the server is broken; reconnect with `npx canary-lab mcp` (the default `lifecycle` carries both surfaces) and then run.
