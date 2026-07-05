---
name: canary-lab-verify
description: Use when verifying a Canary Lab feature against a DEPLOYED environment (staging/production URL) — "verify checkout on staging", "run the saved verify config", "check the deployed app" — through the verify MCP tools (list/get/create/update_verification_config, execute_verification, get_verification_result). No local boot, no heal loop. For local run + heal use canary-lab-run; for end-to-end onboarding use canary-lab (flight).
type: skill
---

# Canary Lab — Deployed-Environment Verification

Connect with the `verify` MCP profile (`npx canary-lab mcp --profile verify`);
the composite `lifecycle`/`full` profiles carry the same tools. Verification
runs the feature's Playwright specs against a saved environment config
(remote URLs) — services are NOT booted locally and there is no heal loop.

## Workspace Bootstrap

1. Read `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`); one workspace → use it, several → ask which, none → ask the user to run `npx canary-lab setup`.
2. Check `/mcp/health` on the UI's port (default `7421`; a project may pin its own in `canary-lab.config.json` — `npx canary-lab mcp doctor` discovers the active URL). Confirm `projectRoot` matches the selected workspace.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal.

## Verification Loop

1. `list_verification_configs` (optionally filtered by feature) shows the saved configs; `get_verification_config` reads one. In the UI, "Playwright" names which env file the specs run with and "Services" names the health-check targets — keep those domain labels when relaying.
2. Create or adjust a config with `create_verification_config` / `update_verification_config` — a config binds a feature to a target environment (base URLs, env set, health-check expectations). Ask the user for the target URLs rather than inventing them.
3. `execute_verification(configId)` starts the verification run; it returns a run reference.
4. Poll `get_verification_result` for the outcome; report pass/fail per test with `result.counts.statusLine`-style counts. There is no heal claim here — a failure is a finding to report (and possibly a `canary-lab-run` follow-up locally), not something to fix against the deployed environment.
5. `boot_services` / `abort_run` exist in this profile for held boot sessions when a config needs a locally booted dependency — use them only when the config genuinely requires it, and only abort with the user's confirmation.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- Never point a verification at production endpoints the user didn't name explicitly.
- Verification results are evidence about the deployed environment; don't edit app code or tests in response — hand findings to the user (or switch to `canary-lab-run` for a local repair loop if they ask).
