# `shared/` — public API vs. internals

Code here is imported by both apps *and*, for four modules, by every scaffolded
workspace on disk. Those four are semver surface; the rest is free to change.

## Public — four paths, published via `package.json` `exports`

Consumers import these by package specifier, never by repo path. Scaffolded
features depend on them directly (see `templates/project/features/*/`).

| Consumer writes | Source | Used by |
| --- | --- | --- |
| `canary-lab/feature-support/playwright-base` | `shared/configs/playwright.base.ts` | every `playwright.config.ts` |
| `canary-lab/feature-support/log-marker-fixture` | `shared/e2e-runner/log-marker-fixture.ts` | every `e2e/*.spec.ts` |
| `canary-lab/feature-support/load-env` | `shared/configs/loadEnv.ts` | envset loading |
| `canary-lab/feature-support/types` | `shared/launcher/types.ts` | feature config typing |

Changing an exported signature, or renaming one of these files, **breaks every
generated workspace already on disk** — including ones we cannot see. Treat it as
a breaking release, not a refactor. `npm run smoke:pack` is the check that proves
the paths still resolve inside the tarball.

## Internal — everything else

`cli-ui/`, `coverage/`, `flights/`, `lib/`, `run-state/`, `runtime/`, and the
non-exported files under `configs/`, `e2e-runner/`, and `launcher/` are internal.
Move, rename, and reshape them freely; only the repo has to agree.

Splitting the public four into their own directory (`shared/public/`) would make
the boundary structural instead of documented — but it changes four published
specifiers, so it is a breaking change and deliberately not done here.
