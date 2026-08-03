---
name: cl_add-sample-feature
description: Use when creating or editing a sample feature under templates/project/features/ — feature.config.cjs, envsets, e2e specs — or when a template change doesn't show up in a scaffolded workspace (for general pre-claim verification checks use cl_verify-changes).
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# Authoring Canary Lab Sample Features

Sample features are the scaffold every consumer starts from, and they only ship via
the build (`templates/project/` → `dist/templates/`, copied by
`tools/prepare-assets.mjs`). Editing them without `smoke:pack` proves nothing.

## What ships (pick the closest as a model)

Two features over one demo app — `templates/project/demo-app/`, a storefront of
three services. The four toy samples (`example_todo_api`, `broken_todo_api`,
`flaky_orders_api`, `tricky_checkout_api`) were retired in 1.6.0.

| Sample | Role |
| --- | --- |
| `demo_inventory` → `demo-app/inventory-service` | **Deliberately correct.** The green first Run, and the Benchmark's subject — it sabotages a working app, so a red baseline can never score. Its specs are un-annotated on purpose: the "before you annotate" state. **Keep it passing.** |
| `demo_catalog` → `demo-app/catalog-service` | Three planted defects — the heal-loop target. **Two fail on the first run; the third cannot fail until the second is fixed** (ids come from the catalog's size, which only breaks once removal works), so the loop genuinely takes several cycles. Keep that staging if you edit the service — a one-pass demo hides the product. Also carries the annotated PRD (`docs/prd.md` + the `_prd-summary.json` sidecar) and the `@req-`/`@path-` tags, so it is the requirement-coverage demonstration too. |
| *(none)* → `demo-app/checkout-service` | Deliberately **not** onboarded, so a flight has something to build from scratch. Nothing in `features/` may point at it, or the similarity gate skips seven stages. |

## Anatomy

```
templates/project/features/<name>/
├── feature.config.cjs      # CommonJS, exports { config }
├── playwright.config.ts
├── e2e/                    # specs + helpers/
├── envsets/                # envsets.config.json + <env>/<slot>.env
└── docs/                   # prd.md + the generated _prd-summary.* sidecars
```

Both shipped features point `localPath` **outward** at `demo-app/<service>`
rather than at their own folder — the feature and the app it tests are separate
things, which is how a real feature looks. No shipped sample is self-contained
any more, so `scripts/` inside a feature dir is a legacy shape only.

`feature.config.cjs` essentials (see `demo_catalog` for a commented example):

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
5. Consumers sync scaffolded docs/skills via `npx canary-lab upgrade` (it lints
   but does not overwrite their `features/`); new-feature templates only reach
   NEW scaffolds — note upgrade-worthiness in the changelog when releasing.

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| Skipping `smoke:pack` | The template never reached `dist/templates/` — consumers scaffold the old version |
| Hardcoding a port in a spec or script | Breaks per-run allocation and concurrent runs |
| Importing from `@playwright/test` directly | Loses the log-marker fixture — run capture can't slice failures |
| Forgetting the production envset when `envs` lists it | Env dropdown offers an env that can't apply |
