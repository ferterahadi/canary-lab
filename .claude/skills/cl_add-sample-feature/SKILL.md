---
name: cl_add-sample-feature
description: Use when creating or editing a sample feature under templates/project/features/ — feature.config.cjs, envsets, e2e specs — or when a template change doesn't show up in a scaffolded workspace (for general pre-claim verification checks use cl_verify-changes).
---

# Authoring Canary Lab Sample Features

The public scaffold intentionally ships **no pre-authored feature**. It ships one
bare product repository at `templates/project/demo-app/` so `npm run demo` can
show the complete Flight from Repo scan through Evaluation. Adding any feature
under `templates/project/features/` changes that product contract and requires
explicit product approval.

Template files only ship via the build (`templates/project/` →
`dist/templates/`, copied by `tools/prepare-assets.mjs`). Editing them without
`smoke:pack` proves nothing.

## What ships

`demo-app/` is a three-service storefront with one ordered journey:

```text
catalog-service → inventory-service → checkout-service
 product + SKU       reservation        final total
```

Each service contains one application defect. The acceptance journey stops at
the first broken contract, so repairing catalog reveals inventory, and repairing
inventory reveals checkout. Keep that dependency chain: a repair agent that can
fix the whole demo in one observed failure has erased the multi-cycle evidence.

The deterministic contributor gate uses
`tools/fixtures/demo-storefront-feature/`. That fixture is internal evidence for
`npm run smoke:demo`; it must never be copied into a scaffolded workspace.

## Anatomy

```
templates/project/features/<name>/
├── feature.config.cjs      # CommonJS, exports { config }
├── playwright.config.ts
├── e2e/                    # specs + helpers/
├── envsets/                # envsets.config.json + <env>/<slot>.env
└── docs/                   # prd.md + the generated _prd-summary.* sidecars
```

`feature.config.cjs` essentials (see the contributor-only storefront fixture for
a multi-service example):

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
  default (see `tools/fixtures/demo-storefront-feature/e2e/helpers/api.ts`) so
  the same spec runs locally and against a remote env.

## Checklist

1. Confirm the new feature is meant to ship in every consumer workspace. The
   canonical demo must remain un-onboarded.
2. Start from `npx canary-lab new feature`; rename consistently (folder,
   `config.name`, `startCommand.name`, envset file names).
3. Declare ports + `${port.<slot>}` everywhere a port appears — never hardcode.
4. Add envsets for every env in `envs`; remote envs point `GATEWAY_URL` at the
   target and gate `startCommands` with `envs: ['local']`.
5. Tier-1 checks per `cl_verify-changes`, then **always finish with
   `npm run smoke:pack`** — it scaffolds a temp workspace and proves the template
   ships.
6. Consumers sync scaffolded docs/skills via `npx canary-lab upgrade` (it lints
   but does not overwrite their `features/`); new-feature templates only reach
   NEW scaffolds — note upgrade-worthiness in the changelog when releasing.

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| Skipping `smoke:pack` | The template never reached `dist/templates/` — consumers scaffold the old version |
| Hardcoding a port in a spec or script | Breaks per-run allocation and concurrent runs |
| Importing from `@playwright/test` directly | Loses the log-marker fixture — run capture can't slice failures |
| Forgetting the production envset when `envs` lists it | Env dropdown offers an env that can't apply |
