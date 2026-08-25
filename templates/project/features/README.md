# Features

This workspace includes two examples:

- **`storefront-journey`** — a three-service `demo-app/` suite. Press **Run** to
  watch the repair loop fix contract failures until green.
- **`workflow-workbench`** — a small suite over `workflow-app/`. Its health test
  starts unlinked, its greeting test is absent, and its service port is fixed,
  giving Coverage, Author, Verify, and Portify prepared material to inspect.

`storefront-journey` ships **finished**:

| Part | Where |
|---|---|
| Services + injectable ports | `feature.config.cjs` — three services, a port slot each, so two copies run side by side |
| Captured environment | `envsets/local/` — the `local` envset the config declares, applied on every run |
| Requirements | `docs/storefront-journey-prd.md` (collected from `demo-app/REQUIREMENTS.md`) distilled into `docs/_prd-summary.*` |
| Tests + coverage | `e2e/storefront.spec.ts` — seven journeys whose `@req-*` tags map all twelve requirements, so the ledger reads 100% |
| What's left | the run itself. Ten of the twelve contracts start broken on purpose |

To onboard from nothing, start a Flight on `flight-app/`, which has no suite.

After the tour, delete the examples and add your own:

```bash
npx canary-lab new feature <name>
```

Or point Flight at a product repo to author and evaluate the suite.
