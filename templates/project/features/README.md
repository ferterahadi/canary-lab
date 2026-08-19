# Features

This workspace ships two worked examples so you can see what Canary Lab does
before pointing it at your own code:

- **`storefront-journey`** — a suite over the bundled `demo-app/` three-service
  storefront. Press **Run** and watch the repair loop work through the broken
  service contracts, a batch at a time, until the suite is green.
- **`workflow-workbench`** — a small suite over `workflow-app/`. It has one
  intentionally uncovered requirement and one fixed service port, giving the
  Coverage, Author, Verify, and Portify workflows prepared material to inspect.

It ships **finished**, so you can read what a fully onboarded suite looks like:

| Part | Where |
|---|---|
| Services + injectable ports | `feature.config.cjs` — three services, a port slot each, so two copies run side by side |
| Captured environment | `envsets/local/` — the `local` envset the config declares, applied on every run |
| Requirements | `docs/storefront-journey-prd.md` (collected from `demo-app/REQUIREMENTS.md`) distilled into `docs/_prd-summary.*` |
| Tests + coverage | `e2e/storefront.spec.ts` — seven journeys whose `@req-*` tags map all twelve requirements, so the ledger reads 100% |
| What's left | the run itself. Ten of the twelve contracts start broken on purpose |

For the other half of the product — onboarding a repo that has *none* of this —
start a Flight on the bundled `flight-app/`, which ships with no suite at all.

Delete the two suites and their bundled apps once you have seen them; they are
demonstrations, not scaffolding you need. Then add your own:

```bash
npx canary-lab new feature <name>
```

Or point a Flight at a product repository and let it author the suite for you,
from repo scan through evaluation export.
