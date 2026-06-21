# Feature Folders

How features are structured in Canary Lab. For the overview, quick start, and core workflow, see the [README](../README.md).

A feature lives under `features/<name>/` with `feature.config.cjs`, a Playwright config, specs under `e2e/`, and envsets under `envsets/`.

Create one from the UI or with:

```bash
npx canary-lab new feature checkout-discounts --description "Validate checkout discounts"
```

The UI's Add Test flow can also turn a PRD or uploaded document into a generated plan and Playwright files for review. Generated tests still run through Playwright.

## Verified Coverage

A feature can also carry a `docs/` folder of source material (specs, tickets, notes as `*.md`). Canary Lab summarizes that collection into a **PRD** — a list of requirements, each with a stable id — stored back in `docs/` as `_prd-summary.json` (+ a readable `_prd-summary.md`). Regeneration preserves existing requirement ids, so the links below never break as the docs evolve.

Tie tests to requirements with Playwright tags **on** the `test()` (greppable, rename-proof):

```ts
test('DELETE /todos/:id removes a todo', { tag: ['@req-R3', '@path-happy'] }, async () => { /* ... */ })
```

- `@req-<id>` — repeatable; a test may cover several requirements.
- `@path-happy|sad|edge` — happy = the expected flow, sad = the negative/error flow, edge = a boundary case.
- Legacy `// @requirement <id>` / `// @path happy` comments above the test still parse as a fallback.

Open the **Coverage** view (the 🎯 pill in the top bar, per selected feature) for the ledger: requirements on the left, tests on the right, synced colour highlighting between them. A requirement is **Verified** only when a test annotated to it has actually passed in a run (ground truth from run history) — so the headline coverage % is evidence, not opinion. Gaps are flagged as:

- **Untested** — a requirement with no annotated test.
- **Unverified** — a test exists but no passing run backs it (the dangerous one).
- **Path-incomplete** — the happy path passed but a sad/edge path is missing.
- **Shallow-verified** — it passes, but the test only reaches a weak assertion tier when a stronger one is achievable.

The **rigor / strictness** score grades each covering test by which layer it actually checks — an app log (tier 1), internal state (tier 2), the app API (tier 3), or a browser confirming the real effect (tier 4) — and surfaces the stronger check to write. The `example_todo_api` sample ships an annotated PRD demonstrating all of this.
