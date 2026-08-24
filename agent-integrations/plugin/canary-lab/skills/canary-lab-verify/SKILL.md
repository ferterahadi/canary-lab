---
name: canary-lab-verify
description: Use when verifying a Canary Lab feature against a RUNNING target — a deployed environment ("verify checkout on staging", "run the saved verify config", "check the deployed app") or a locally booted app ("verify a running app") — through the verify MCP tools (list/get/create/update_verification_config, boot_services, execute_verification, get_verification_result). No heal loop. For run + heal use canary-lab-run; for end-to-end onboarding use canary-lab (flight).
type: skill
---

# Canary Lab — Environment Verification

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

These tools arrive via the Canary Lab MCP server. If this client is already
connected (the plugin connects with `compact`), skip this step. To configure
the same connection manually: `npx canary-lab mcp --profile compact`. Verification runs the
feature's Playwright specs against target URLs — a deployed environment
(saved config, remote URLs) or a local app you first bring up with
`boot_services`. There is no heal loop either way.

## Arguments

An invocation argument (`/canary-lab-verify <suite>`) is a suite (feature) name
in the connected workspace. Use it directly, then choose the **Local app** or
**Deployed environment** flow below from the target the user named.

## Workspace Bootstrap

1. Find the LIVE server first: read `~/.canary-lab/active-servers.json`, which records `projectRoot`, `port` and `pid` for every UI that registered. A stopped server's entry LINGERS — the file is only rewritten when the next server registers — so an entry is a candidate, not proof: the health check below is what confirms it. One entry → that is your server and its `port`. Several → take the one whose `projectRoot` is the workspace the user means. None → fall back to `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`): one workspace → use it, several → ask which, none → ask the user to run `npx canary-lab setup`. Do NOT start from a guessed port.
2. Then CONFIRM it is the right server: `curl -s http://127.0.0.1:<port>/mcp/health` and check that `projectRoot` is the workspace you intended. A healthy response does **not** settle the question on its own — a stale UI left behind by a demo or a tarball smoke test answers a port just as convincingly as the right one, and that is how a flight ends up running in someone's throwaway workspace. `projectRoot` matches what you intended → continue and tell the user which workspace. It names a DIFFERENT workspace → this is the wrong server; go back to step 1 rather than adopting it. It is under a temp directory (`/tmp`, `/private/var/folders`, `%TEMP%`) → never auto-select it; those are throwaway demo workspaces, so use one only when the user names it explicitly. Only when no live server serves the workspace you want does one need starting.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up.
4. A healthy `/mcp/health` means the server is live. On the setup-installed `compact` profile, atomic names such as `get_feature_coverage` are deliberately absent from `tools/list`; only `exec` is public. Call `exec` with `{"command":"list_tools","arguments":{}}` before concluding the connection is missing. Only an unknown-tool error for `exec` means this session is not connected — ask the user to run `npx canary-lab setup --force` and reconnect/restart the client, then retry. Never drive `/mcp` with a hand-written HTTP/JSON-RPC client (curl included; the health check above is the only direct HTTP use): a custom client bypasses client detection and reconnect handling.

## Verification Loop

**Local app** ("verify a running app" — the target is this workspace's own app, not a remote URL):

1. `boot_services(feature)` boots the app's services and HOLDS them (no tests yet). Note the returned `runId` — it is the `bootRunId` everything below needs.
2. Poll `get_run(bootRunId)` until every `manifest.services[]` entry is `status: "ready"` (a `failed`/`timeout` service means the app itself won't start — report it; `abort_run` tears the boot down). Build `targetUrls` from the services: one entry per service, keyed by service name, valued with the **origin** of its `healthUrl` (scheme + host + port, no path).
3. `execute_verification(feature, { targetUrls, playwrightEnvsetId: "local", bootRunId })`. Passing `bootRunId` is required — without it the held boot session itself trips the active-run collision check (409 "Another execution is running"); with it, Canary tears the boot down as the verification starts. Then continue at the polling step below.

**Deployed environment** (staging/production URLs):

1. `list_verification_configs` (optionally filtered by feature) shows the saved configs; `get_verification_config` reads one. In the UI, "Playwright" names which env file the specs run with and "Services" names the health-check targets — keep those domain labels when relaying. A config whose URLs contain `replace.invalid` is a scaffolded placeholder — never execute it as-is; update it with real URLs first (or use the Local app flow above).
2. Create or adjust a config with `create_verification_config` / `update_verification_config` — a config binds a feature to a target environment (base URLs, env set, health-check expectations). Ask the user for the target URLs rather than inventing them.
3. `execute_verification` starts the verification run. `featureId` is required; pass either a saved `configId`, or ad-hoc `targetUrls` + `playwrightEnvsetId`. It returns an `executionId`.

**Both flows**: if `execute_verification` returns `type: "getting_started_busy"`, a Getting Started demo already owns the workspace — follow the active target it returns; do not start another workflow. While the verification runs, the user can watch it live in the Canary Lab UI on the suite's Flight page (Test Run stage, in verify mode) — that view is read-only while this client drives.

**Both flows end the same way**: poll `get_verification_result(executionId)` for the outcome; if it is still running, wait ~10s and call it again — stop once it reaches a terminal status. Report the result's `status`, and on failure the pass/fail counts in the result (`diagnostics.summary` / `diagnostics.failedTests` — there is no `counts` field on a verify result). There is no heal claim here — a failure is a finding to report (and possibly a `canary-lab-run` follow-up locally), not something to fix against the target environment. Only `abort_run` a held boot session with the user's confirmation (the `bootRunId` hand-off above tears it down automatically).

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Never point a verification at production endpoints the user didn't name explicitly.
- Verification results are evidence about the deployed environment; don't edit app code or tests in response — hand findings to the user (or switch to `canary-lab-run` for a local repair loop if they ask).
