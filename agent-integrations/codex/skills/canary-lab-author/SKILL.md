---
name: canary-lab-author
description: Use when creating or extending a Canary Lab feature by hand — "create a feature for X", "add test cases to <feature>", "capture the env files", "switch the feature's branch" — through the author MCP tools (create_feature, capture_feature_env_files, write_envset, start/update/apply_external_draft, get_feature_repo_status, checkout_feature_repo_branch). This client writes the specs; Canary Lab is the control plane. For docs/PRD/coverage use canary-lab-coverage; for full onboarding of a bare repo use canary-lab (flight).
type: skill
---

# Canary Lab — Feature Authoring

Connect with the `author` MCP profile (`npx canary-lab mcp --profile author`);
the composite `lifecycle`/`full` profiles carry the same tools. Canary Lab is
the control plane and artifact store; this client writes the test cases.

## Workspace Bootstrap

1. Read `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`); one workspace → use it, several → ask which, none → ask the user to run `npx canary-lab setup`.
2. Check `/mcp/health` on the UI's port (default `7421`; a project may pin its own in `canary-lab.config.json` — `npx canary-lab mcp doctor` discovers the active URL). Confirm `projectRoot` matches the selected workspace.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal.
4. Do not reflexively call `list_features` or `list_runs` after health. For random or new feature creation, call `create_feature` directly with a unique feature name; use `list_features` only to discover or choose an existing feature.

## Create or Extend a Feature

1. For random or new feature creation, call `create_feature` directly with a unique feature name. It creates the skeleton files and returns test-file rules, envset schema, and next-step tool hints. Do not call `list_features` just to avoid collisions; if the chosen name already exists, retry `create_feature` with a different unique name.
2. If the user asks to preserve existing `.env`, `.env.dev`, `application.properties`, or similar repo config files, inspect the source repo enough to identify the files, then call `capture_feature_env_files`. Do not paste secret values into chat; Canary Lab returns redacted previews only. `write_envset` fills in or corrects individual envset values (it is confirm-gated).
3. Author or edit specs under `features/<feature>/e2e/`.
4. Specs must import:
   ```ts
   import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
   ```
5. Call `start_external_draft` with a stable `session_id` and a useful `conversation_name` (do not pass `client_kind` — the bridge auto-detects it). This only creates a visible Canary Lab task so the user sees that this external client is authoring tests; it does not start an internal wizard agent.
6. After `start_external_draft` returns, tell the user you are authoring tests and they can wait in this external client. Continue writing specs locally, then call `update_external_draft_stage` as work progresses: `scaffolding`, `authoring-tests`, `validating`, `ready`, `applied`, or `error`.
7. Call `apply_external_draft` with the externally authored files, or after writing them locally, so Canary Lab validates and records the applied draft. Do not ask Canary Lab to spawn another Claude/Codex agent for MCP-created authoring.
8. `get_feature_repo_status` / `checkout_feature_repo_branch` inspect and switch the feature's bound repo branches when the user asks to test a different branch.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Canary Lab never writes the test body for external authoring — this client does.
- After authoring, the natural next steps live in sibling skills: map coverage (`canary-lab-coverage`), run + heal (`canary-lab-run`), export the evaluation (`canary-lab-export`).
