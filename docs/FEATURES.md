# Feature Folders

How features are structured in Canary Lab. For the overview, quick start, and core workflow, see the [README](../README.md).

A feature lives under `features/<name>/` with `feature.config.cjs`, a Playwright config, specs under `e2e/`, and envsets under `envsets/`.

Create one from the UI or with:

```bash
npx canary-lab new feature checkout-discounts --description "Validate checkout discounts"
```

The UI's Add Test flow can also turn a PRD or uploaded document into a generated plan and Playwright files for review. Generated tests still run through Playwright.
