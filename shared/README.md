# `shared/` — public API vs. internals

Both apps use this code. Four modules also ship to every scaffolded workspace;
they are the semantic-versioning surface. Everything else is internal.

## Public — four paths, published via `package.json` `exports`

Consumers use package specifiers, never repo paths. See `templates/project/features/*/`.

| Consumer writes | Source | Used by |
| --- | --- | --- |
| `canary-lab/feature-support/playwright-base` | `shared/configs/playwright.base.ts` | every `playwright.config.ts` |
| `canary-lab/feature-support/log-marker-fixture` | `shared/e2e-runner/log-marker-fixture.ts` | every `e2e/*.spec.ts` |
| `canary-lab/feature-support/load-env` | `shared/configs/loadEnv.ts` | envset loading |
| `canary-lab/feature-support/types` | `shared/launcher/types.ts` | feature config typing |

Changing an exported signature or filename **breaks every generated workspace**,
including unseen ones. Treat it as a breaking release. `npm run smoke:pack`
proves the tarball paths still resolve.

## Internal — everything else

`cli-ui/`, `coverage/`, `flights/`, `lib/`, `run-state/`, `runtime/`, and the
non-exported files under `configs/`, `e2e-runner/`, and `launcher/` are internal.
Move, rename, and reshape them freely; only the repo has to agree.

Moving the public four into `shared/public/` would clarify the boundary but change
their published specifiers, so it remains deferred as a breaking change.
