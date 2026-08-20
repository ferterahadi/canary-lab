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

## Workspace Bootstrap

1. Read `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`); one workspace → use it, several → ask which **only if** the health check below does not settle it, none → ask the user to run `npx canary-lab setup`.
2. Check `/mcp/health` on the UI's port: read `port` from the workspace's `canary-lab.config.json` (fallback `7421`), then `curl -s http://127.0.0.1:<port>/mcp/health` — success is a JSON response. `projectRoot` names the workspace that server actually serves, and one server serves one workspace — so a healthy response SETTLES which workspace you are in. Use it, tell the user which one, and do not ask them to pick from the registry or offer to stop the server; a registry entry that disagrees is not a conflict, and a `projectRoot` under a temp directory is a legitimate demo workspace.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up.
4. Do not reflexively call `list_features` or `list_runs` after health. For random or new feature creation, call `create_feature` directly with a unique feature name; use `list_features` only to discover or choose an existing feature.

## Create or Extend a Feature

1. For random or new feature creation, call `create_feature` directly with a unique feature name. It creates the skeleton files and returns test-file rules, envset schema, and next-step tool hints. Do not call `list_features` just to avoid collisions; if the chosen name already exists, retry `create_feature` with a different unique name.
2. If the user asks to preserve existing `.env`, `.env.dev`, `application.properties`, or similar repo config files, inspect the source repo enough to identify the files, then call `capture_feature_env_files`. Do not paste secret values into chat; Canary Lab returns redacted previews only. `write_envset` fills in or corrects individual envset values (it is confirm-gated).
3. Author or edit specs under `<workspace>/features/<feature>/e2e/` — the Canary Lab WORKSPACE, not the product repo under test.
4. Specs must import:
   ```ts
   import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
   ```
5. Call `start_external_draft` with a stable `session_id` and a useful `conversation_name` (do not pass `client_kind` — the bridge auto-detects it). This only creates a visible Canary Lab task so the user sees that this external client is authoring tests; it does not start an internal wizard agent. Carry the `draftId` it returns into every subsequent `update_external_draft_stage` / `apply_external_draft` call for this draft.
6. After `start_external_draft` returns, tell the user you are authoring tests and they can wait in this external client. Continue writing specs locally, then call `update_external_draft_stage(draftId, stage)` as work progresses: `scaffolding`, `authoring-tests`, `validating`, `ready`, `applied`, or `error`.
7. Call `apply_external_draft` with `draftId`, `confirm: true`, and `files: [{path, content}, …]` for the externally authored files (omit `files` if you already wrote them directly under `<workspace>/features/<feature>/e2e/` — it then validates what's on disk), so Canary Lab validates and records the applied draft. Do not ask Canary Lab to spawn another Claude/Codex agent for MCP-created authoring. On a validation error, fix the named file and re-call `apply_external_draft`.
8. `get_feature_repo_status` / `checkout_feature_repo_branch` inspect and switch the feature's bound repo branches when the user asks to test a different branch.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Canary Lab never writes the test body for external authoring — this client does.
- After authoring, the natural next steps live in sibling skills: map coverage (`canary-lab-coverage`), run + heal (`canary-lab-run`), export the evaluation (`canary-lab-export`).
