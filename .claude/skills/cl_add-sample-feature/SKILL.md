---
name: cl_add-sample-feature
description: Use when creating or editing a sample feature under templates/project/features/ — feature.config.cjs, envsets, e2e specs — or when a template change doesn't show up in a scaffolded workspace.
---

# Authoring Canary Lab Sample Features

Sample features are the scaffold every consumer starts from, and they only ship via
the build (`templates/project/` → `dist/templates/`, copied by
`tools/prepare-assets.mjs`). Editing them without `smoke:pack` proves nothing.

## The five existing samples (pick the closest as a model)

| Sample | Role |
| --- | --- |
| `example_todo_api` | Happy path; the canonical config to copy |
| `broken_todo_api` | Intentionally failing — the heal-loop target |
| `flaky_orders_api` | Intermittent failures |
| `tricky_checkout_api` | Hard-to-diagnose failures |
| `acme_cart_checkout` | Larger checkout flow |

## Anatomy

```
templates/project/features/<name>/
├── feature.config.cjs      # CommonJS, exports { config }
├── playwright.config.ts
├── e2e/                    # specs + helpers/
├── envsets/                # envsets.config.json + <env>/<slot>.env
└── scripts/                # service entrypoints (e.g. server.ts)
```

`feature.config.cjs` essentials (see `example_todo_api` for a commented example):

- `envs: ['local', 'production']` — which envsets exist for the feature.
- Each `startCommand`: `command`, `envs: ['local']` to gate local-only boots,
  `ports: [{ name: 'api', env: 'PORT' }]` for per-run port allocation, and a per-env
  `healthCheck` (exactly one transport per probe: `http: { url }` or `tcp: { port }`).
- `${port.<slot>}` is the reserved token for the allocated port — valid in the
  command, the healthCheck URL, and applied envset files. See
  [docs/ARCHITECTURE.md → Concurrency](../../../docs/ARCHITECTURE.md#concurrency).

Spec rules:

- Specs MUST import the fixture:
  `import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'`
- Helpers resolve the target as `CANARY_PORT_<slot>` → `GATEWAY_URL` → hardcoded
  default (see any sample `e2e/helpers/api.ts`) so the same spec runs locally and
  against a remote env.

## Checklist

1. Copy the closest sample; rename consistently (folder, `config.name`,
   `startCommand.name`, envset file names).
2. Declare ports + `${port.<slot>}` everywhere a port appears — never hardcode.
3. Add envsets for every env in `envs`; remote envs point `GATEWAY_URL` at the
   target and gate `startCommands` with `envs: ['local']`.
4. Tier-1 checks per `cl_verify-changes`, then **always finish with
   `npm run smoke:pack`** — it scaffolds a temp workspace and proves the template
   ships.
5. Consumers pick up sample changes via `npx canary-lab upgrade` — mention
   upgrade-worthiness in the changelog entry when releasing.

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| Skipping `smoke:pack` | The template never reached `dist/templates/` — consumers scaffold the old version |
| Hardcoding a port in a spec or script | Breaks per-run allocation and concurrent runs |
| Importing from `@playwright/test` directly | Loses the log-marker fixture — run capture can't slice failures |
| Forgetting the production envset when `envs` lists it | Env dropdown offers an env that can't apply |
