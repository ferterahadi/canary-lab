---
name: canary-lab-verify
description: Use when verifying a Canary Lab feature against a DEPLOYED environment (staging/production URL) — "verify checkout on staging", "run the saved verify config", "check the deployed app" — through the verify MCP tools (list/get/create/update_verification_config, execute_verification, get_verification_result). No local boot, no heal loop. For local run + heal use canary-lab-run; for end-to-end onboarding use canary-lab (flight).
type: skill
---

# Canary Lab — Deployed-Environment Verification

These tools arrive via the Canary Lab MCP server. If this client is already
connected (the plugin connects with `full`), skip this step. To configure a
connection manually: `npx canary-lab mcp --profile verify` (the composite
`lifecycle`/`full` profiles carry the same tools). Verification runs the
feature's Playwright specs against a saved environment config (remote URLs)
— services are NOT booted locally and there is no heal loop.

## Workspace Bootstrap

1. Read `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`); one workspace → use it, several → ask which, none → ask the user to run `npx canary-lab setup`.
2. Check `/mcp/health` on the UI's port: read `port` from the workspace's `canary-lab.config.json` (fallback `7421`), then `curl -s http://127.0.0.1:<port>/mcp/health` — success is a JSON response. Confirm `projectRoot` matches the selected workspace.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up.

## Verification Loop

1. `list_verification_configs` (optionally filtered by feature) shows the saved configs; `get_verification_config` reads one. In the UI, "Playwright" names which env file the specs run with and "Services" names the health-check targets — keep those domain labels when relaying.
2. Create or adjust a config with `create_verification_config` / `update_verification_config` — a config binds a feature to a target environment (base URLs, env set, health-check expectations). Ask the user for the target URLs rather than inventing them.
3. `execute_verification` starts the verification run. `featureId` is required; pass either a saved `configId`, or ad-hoc `targetUrls` + `playwrightEnvsetId`. It returns an `executionId`.
4. Poll `get_verification_result(executionId)` for the outcome; if it is still running, wait ~10s and call it again — stop once it reaches a terminal status. Report the result's `status`, and on failure the pass/fail counts in the result (`diagnostics.summary` / `diagnostics.failedTests` — there is no `counts` field on a verify result). There is no heal claim here — a failure is a finding to report (and possibly a `canary-lab-run` follow-up locally), not something to fix against the deployed environment.
5. `boot_services` / `abort_run` exist in this profile for held boot sessions when a config needs a locally booted dependency — use them only when the config genuinely requires it, and only abort with the user's confirmation.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Never point a verification at production endpoints the user didn't name explicitly.
- Verification results are evidence about the deployed environment; don't edit app code or tests in response — hand findings to the user (or switch to `canary-lab-run` for a local repair loop if they ask).
