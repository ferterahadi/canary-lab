---
name: cl_add-sample-feature
description: Use when creating or editing a sample feature under templates/project/features/ — feature.config.cjs, envsets, e2e specs — or when a template change doesn't show up in a scaffolded workspace (for general pre-claim verification checks use cl_verify-changes).
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# Authoring Canary Lab Sample Features

The public scaffold **ships its own demonstration**. It carries
the storefront product repository at `templates/project/demo-app/` *and* the
`storefront-journey` suite that exercises it, so a first-time user can press Run
and watch fail → repair → green without authoring anything.

The trade is deliberate: discoverability for a first-time user beats a
clean scaffold for an experienced one, and `features/README.md` tells users they
can delete the samples once they have seen them. Adding a *further* feature under
`templates/project/features/` still changes the product contract and still needs
explicit product approval.

`npm run demo` adds **nothing** of its own — it packs the current build, runs the
real `canary-lab init`, and opens the UI. That is what makes it a developer's
test of the init experience: anything missing from the scaffold is missing from
the demo, visibly.

Template files only ship via the build (`templates/project/` →
`dist/templates/`, copied by `tools/prepare-assets.mjs`). Editing them without
`smoke:pack` proves nothing.

## What ships

`demo-app/` is a three-service storefront with one ordered journey:

```text
catalog-service → inventory-service → checkout-service
 product + SKU       reservation        final total
```

`demo-app/REQUIREMENTS.md` states seven journeys as twelve contracts — five
ordered pairs plus two sound ones (J0, J6) that pass from the first run — and the
services carry ten application defects between them. Every
journey is ONE Playwright test whose assertions are ordered, and
`maxFailures: 1` stops the run at the first failing journey, so a repair agent
sees exactly one broken contract per cycle and each repair reveals the next.

Keep all of that when editing. Three traps, each of which cost a full gate run:

- **`maxFailures` in `playwright.config.ts` does not decide anything.**
  `healOnFailureThreshold` in `feature.config.cjs` becomes `--max-failures=N` on
  the command line and overrides it. The fixture sets it to `1`; at the default
  `2`, two journeys fail together and the chain stops being a chain.
- **Defects must be stateless.** The services hold data in memory and are NOT
  restarted between heal cycles. A defect that leaks state (a reservation that
  survives its own refusal) drifts every rerun and eventually breaks the setup
  of the very journey that was meant to catch it.
- **A defect must sit on a code path no earlier journey exercises**, or it fails
  the wrong journey first — and repairing it then looks like a no-op.

The suite declares each service as **its own repo entry with exactly one start
command**, all three pointing at `demo-app/`. The schema does allow one repo
entry to carry several start commands, but the demo deliberately does not use
that: one entry per service is the shape a real deployment has, it gives each
service its own per-run worktree so a repair lands only in the checkout the
broken service serves from, and it makes the run's Changes tab group repairs by
service instead of pooling them under one repo name.

The suite lives at `templates/project/features/storefront-journey/` and ships
with every scaffold. `npm run smoke:demo` repairs it deterministically as an
LLM-free gate; `npm run demo` leaves it for the tester. `smoke:pack` asserts it
reaches a scaffolded workspace — a template edit that never reached
`dist/templates/` fails there.

## Anatomy

```
templates/project/features/<name>/
├── feature.config.cjs      # CommonJS, exports { config }
├── playwright.config.ts
├── e2e/                    # specs + helpers/
├── envsets/                # envsets.config.json + <env>/<slot>.env
└── docs/                   # prd.md + the generated _prd-summary.* sidecars
```

`feature.config.cjs` essentials (the shipped `storefront-journey` config is the
three-service example):

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
  default (see `templates/project/features/storefront-journey/e2e/helpers/api.ts`) so
  the same spec runs locally and against a remote env.

## Checklist

1. Confirm the new feature is meant to ship in every consumer workspace. The
   scaffold already carries `storefront-journey`; a second shipped feature needs
   explicit product approval.
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
