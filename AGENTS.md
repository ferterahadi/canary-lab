# Canary Lab - Internal Notes

## Current Package Model

- Publish one CLI: `canary-lab`
- Main subcommands: `init`, `run`, `env`, `new-feature`
- Package internals ship as compiled code in `dist/`
- Scaffold templates live in `templates/project/` and are copied into `dist/templates/` during build

## Repository Workflow

- Build with `npm run build`
- Smoke-test the tarball with `npm run smoke:pack`
- Publish with `npm run publish:package`

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
