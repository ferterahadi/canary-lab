# Canary Lab - Internal Notes

## Current Package Model

- Publish one CLI: `canary-lab`
- Main subcommands: `init`, `run`, `env`, `new-feature`
- Package internals ship as compiled code in `dist/`
- Scaffold templates live in `templates/project/` and are copied into `dist/templates/` during build

## Repository Workflow

- Build with `npm run build`
- Inspect the tarball with `npm run pack:check`
- Smoke-test the tarball with `npm run smoke:pack`
- Publish with `npm run publish:package`

## Feature Notes

- Repo sample features now use `feature.config.cjs` and JS-based Playwright/test files
- Generated features import package helpers from `canary-lab/feature-support/...`
- The scaffold includes `example_todo_api` and `broken_todo_api`
