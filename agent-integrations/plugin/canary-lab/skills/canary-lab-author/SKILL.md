---
name: canary-lab-author
description: Use when creating or extending a Canary Lab feature by hand — "create a feature for X", "add test cases to <feature>", "capture the env files", "switch the feature's branch" — through the author MCP tools (create_feature, capture_feature_env_files, write_envset, start/update/apply_external_draft, get_feature_repo_status, checkout_feature_repo_branch). For docs/PRD/coverage use canary-lab-coverage; for full onboarding of a bare repo use canary-lab (flight).
type: skill
---

# Canary Lab — Feature Authoring

## MCP Invocation

Setup and the plugin expose one public Canary Lab MCP tool: `exec` (usually
rendered as `mcp__Canary_Lab__exec`). Every
Canary Lab tool name below is the exact `command` value, not a separate public
tool. For a feature-scoped command, replace both placeholders in this shape:

```json
{"command":"<exact_tool_name>","arguments":{"feature":"<feature_name>"}}
```

This is the envelope shape, not every command's complete schema. Add the
fields that command declares inside `arguments`; call `describe_tool` when a
field is uncertain.

Never invent a wrapper verb such as `learn` or `call`, embed JSON in a command
string, or turn arguments into flags. Keep fields such as `confirm: true` inside
`arguments`. Use `list_tools`, `search_tools`, or `describe_tool` as the
`command` when discovery is needed. A deliberately selected focused or `full`
profile still exposes atomic tools for debugging; the setup-installed path is
`compact` + `exec`.

This client writes the specs; Canary Lab is the control plane and artifact
store. These tools arrive via the Canary Lab MCP server. If this client is
already connected (the plugin connects with `compact`), skip this step. To
configure the same connection manually: `npx canary-lab mcp --profile compact`.

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
5. A healthy `/mcp/health` means the server is live. On the setup-installed `compact` profile, atomic names such as `get_feature_coverage` are deliberately absent from `tools/list`; only `exec` is public. Call `exec` with `{"command":"list_tools","arguments":{}}` before concluding the connection is missing. Only an unknown-tool error for `exec` means this session is not connected — ask the user to run `npx canary-lab setup --force` and reconnect/restart the client, then retry. Never drive `/mcp` with a hand-written HTTP/JSON-RPC client (curl included; the health check above is the only direct HTTP use): a custom client bypasses client detection and reconnect handling.

## Create or Extend a Feature

1. Pick the path by what the request names:
   - **Extending an EXISTING feature** ("author tests for <feature>", "add a test for the missing behavior"): do NOT call `create_feature` — the feature and its skeleton already exist. To choose WHAT to test, `get_feature_coverage(feature)` names the untested / path-incomplete requirements (that IS the "choose a gap" step), and `list_feature_docs(feature)` points at the requirement docs behind them. Author the new spec straight into `<workspace>/features/<feature>/e2e/`, and tag it with the requirement it covers — `test('…', { tag: ['@req-R2'] }, …)` — so the gap actually closes in the coverage ledger.
   - **Creating a NEW feature**: call `create_feature` directly with a unique feature name. It creates the skeleton files and returns test-file rules, envset schema, and next-step tool hints. Do not call `list_features` just to avoid collisions; if the name you INVENTED already exists, retry `create_feature` with a different unique name — but never rename away from a feature the user asked for (that is the extending path above).
2. If the user asks to preserve existing `.env`, `.env.dev`, `application.properties`, or similar repo config files, inspect the source repo enough to identify the files, then call `capture_feature_env_files`. Do not paste secret values into chat; Canary Lab returns redacted previews only. `write_envset` fills in or corrects individual envset values (it is confirm-gated).
3. Author or edit specs under `<workspace>/features/<feature>/e2e/` — the Canary Lab WORKSPACE, not the product repo under test.
   **Spec selection never depends on the envset.** In the suite's
   `playwright.config.*`, keep `testDir`, `testMatch`, `testIgnore`, `grep` and
   `grepInvert` as constant literals — never derived from
   `CANARY_LAB_MANIFEST_PATH`, `process.env`, or the recorded env. A test that
   must not execute in some environment skips ITSELF at runtime:
   `test.skip(process.env.VERIFICATION_ENV !== 'meta', 'needs the Meta sandbox')`,
   reading the env from the envset's own values rather than the manifest. See
   Guardrails for why.
4. Specs must import:
   ```ts
   import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
   ```
5. Call `start_external_draft` with a stable `session_id` and a useful `conversation_name` (do not pass `client_kind` — the bridge auto-detects it). This only creates a visible Canary Lab task so the user sees that this external agent session is authoring tests; it does not start an internal wizard agent. Carry the `draftId` it returns into every subsequent `update_external_draft_stage` / `apply_external_draft` call for this draft. If it returns `type: "getting_started_busy"`, a Getting Started demo already owns the workspace — follow the active target it returns; do not start another workflow.
6. After `start_external_draft` returns, tell the user you are authoring tests and they can follow along live in the Canary Lab UI: the suite's Flight page shows this work on its Test authoring & coverage stage (that view is read-only while this client drives — it monitors, you act here). Continue writing specs locally, then call `update_external_draft_stage(draftId, stage)` as work progresses: `scaffolding`, `authoring-tests`, `validating`, `ready`, `applied`, or `error`.
7. Call `apply_external_draft` with `draftId`, `confirm: true`, and `files: [{path, content}, …]` for the externally authored files (omit `files` if you already wrote them directly under `<workspace>/features/<feature>/e2e/` — it then validates what's on disk), so Canary Lab validates and records the applied draft. Do not ask Canary Lab to spawn another Claude/Codex agent for MCP-created authoring. On a validation error, fix the named file and re-call `apply_external_draft`.
8. `get_feature_repo_status` / `checkout_feature_repo_branch` inspect and switch the feature's bound repo branches when the user asks to test a different branch.

## Guardrails

- Write one variable declaration per statement, use descriptive names, and clearly
  separate setup, action, and assertions. Avoid comma expressions and nested
  conditionals. Draft acceptance splits ordinary grouped declarations and formats
  specs; it rejects syntax errors and comma expressions and reports nested
  conditionals for review. Preserve behavior while resolving any finding.
- Audit existing tests with `canary-lab test-readability <file-or-directory>`;
  add `--fix` for safe declaration fixes and formatting, or `--rules-only` to keep
  existing layout. Review the diff and rerun affected tests. Never weaken assertions
  or rewrite recorded run artifacts during cleanup.
- Keep the same `session_id` for the whole conversation.
- Test titles are read by non-engineers in the coverage ledger and exported
  reports: write each as a plain-English sentence naming the user-visible
  behavior — `user can reset their password after requesting a reset link`,
  not `POST /reset-token returns 200`. Keep a technical term only when it is
  the requirement's own vocabulary (an endpoint name in an API-contract
  requirement stays technical).
- Canary Lab never writes the test body for external authoring — this client does.
- **A suite declares ONE roster of tests, and every run of it declares the same
  one.** Playwright builds that roster by walking the suite with the config's
  selection fields applied, before the first test starts, and that walk is the
  run's evidence. A config that narrows it by environment does not hide tests
  from a run — it deletes them from the record: a `meta` run of a 45-test suite
  reports a 4-test suite, the other 41 absent rather than "not run", and two runs
  of one suite can no longer be compared. `test.skip(condition, reason)` keeps
  the roster whole; a `testMatch` filter destroys it at the source. Canary Lab
  refuses both the draft that carries such a config and any run of the suite.
- After authoring, the natural next steps live in sibling skills: map coverage (`canary-lab-coverage`), run + heal (`canary-lab-run`), export the evaluation (`canary-lab-export`). **Running the new test** needs `start_run`: on the setup/plugin `compact` connection, invoke it as the `exec` command and follow `canary-lab-run`. On an intentionally narrow direct `--profile author` connection it is unavailable; reconnect with `npx canary-lab mcp --profile compact` and then run.
