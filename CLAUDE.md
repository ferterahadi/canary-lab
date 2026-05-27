# Canary Lab - Internal Notes

## Current Package Model

- Publish one CLI: `canary-lab`
- Main subcommands: `init`, `setup`, `ui`, `mcp`, `new feature`, `env`, `upgrade`
- Package internals ship as compiled code in `dist/`
- Scaffold templates live in `templates/project/` and are copied into `dist/templates/` during build

## Repository Workflow

- Build with `npm run build`
- Smoke-test the tarball with `npm run smoke:pack`
- Publish with `npm run publish:package`
- Run tests with `npx vitest run` (vitest; tests co-located as `*.test.ts`, component tests use happy-dom)
- Typecheck with `npx tsc -p tsconfig.build.json --noEmit`

## Feature Notes

- Repo sample features now use `feature.config.cjs` and JS-based Playwright/test files
- Generated features import package helpers from `canary-lab/feature-support/...`
- The scaffold includes `example_todo_api` and `broken_todo_api`

## Testing Against a Remote URL

To run a feature's tests against a deployed environment without booting the local server:

1. Add the env to `feature.config.cjs` → `envs: ['local', 'production']`.
2. Gate each `startCommand` (or whole `repo`) with `envs: ['local']` so it only boots locally.
3. Add a matching envset under `envsets/<env>/<feature>.env` with the remote target — e.g. `GATEWAY_URL=https://api.example.com`. Tests read this via `process.env.GATEWAY_URL` (see `e2e/helpers/api.ts`).
4. Pick the env at the runner prompt (`canary-lab run`) or from the env dropdown in the web UI (`canary-lab ui`). Both flows apply/revert the envset and skip booting filtered services.

## External AI Clients (MCP)

- MCP HTTP server mounts at `localhost:7421/mcp` (streamable HTTP) inside `canary-lab ui`. Health: `GET /mcp/health?profile=<p>`.
- **Profiles** pick the tool subset via `?profile=`: `repair` (heal loop, default), `verify` (verification configs), `author` (feature/envset/draft/eval authoring), `full` (union). Optional `?client_kind=claude-desktop|codex-cli|...`.
- Tools live in `apps/web-server/mcp/tools.ts` — thin wrappers over existing REST routes/helpers. `start_run`/`write_envset`/etc. reuse handlers via `app.inject()`; don't duplicate orchestrator logic.
- Profile membership = the `REPAIR_TOOLS`/`VERIFY_TOOLS`/`AUTHOR_TOOLS` arrays. `FULL_TOOLS` auto-dedupes their union + `FULL_ONLY_TOOLS`. Adding/moving a tool also requires updating the mirror arrays in `mcp/server.smoke.test.ts`.
- Each MCP session gets its own transport (`mcp/server.ts`) — a singleton rejects the 2nd client with `-32600 Server already initialized`.
- Destructive tools gate on `confirm: z.literal(true)` in their input schema (e.g. `abort_run`, `write_envset`).
- **External heal**: when `manifest.healMode === 'external'` the orchestrator parks at `waiting-for-signal` and the client drives `claim_heal` → `get_heal_context` → edit code → `signal_run`. `ExternalHealBroker` (`lib/external-heal-broker.ts`) owns the single-claim lock + 15s heartbeat staleness. Per-command audit log at `<runDir>/external-commands.jsonl`.
- Handoff (`handoff_heal`): active runs can only hand off to `manual` (orchestrator can't add a local autoHeal mid-flight); `auto`/`claude`/`codex` require a failed/aborted run.
- End-to-end smoke for the heal loop: `tools/verify-external-heal.sh` (auto-picks a failing feature, runs the 7-step REST loop; `KEEP_RUN=1`, `FEATURE=`, `WAIT_FOR_HEALING_SECONDS=` overrides).
