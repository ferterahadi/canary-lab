# Feature Folders

How features are structured in Canary Lab. For the overview, quick start, and core workflow, see the [README](../README.md).

A feature lives under `features/<name>/` with `feature.config.cjs`, a Playwright config, specs under `e2e/`, and envsets under `envsets/`.

Create one from the UI or with:

```bash
npx canary-lab new feature checkout-discounts --description "Validate checkout discounts"
```

The UI's Add Test flow can also turn a PRD or uploaded document into a generated plan and Playwright files for review. Generated tests still run through Playwright.

## Requirement Coverage

A feature can also carry a `docs/` folder of source material (specs, tickets, notes as `*.md`). Canary Lab summarizes that collection into a **PRD** — a list of requirements, each with a stable id — stored back in `docs/` as `_prd-summary.json` (+ a readable `_prd-summary.md`). Regeneration preserves existing requirement ids, so the tags below never break as the docs evolve.

Tie tests to requirements with Playwright tags **on** the `test()` (greppable, rename-proof):

```ts
test('DELETE /todos/:id removes a todo', { tag: ['@req-R3', '@path-happy'] }, async () => { /* ... */ })
```

- `@req-<id>` — repeatable; a test may cover several requirements.
- `@path-happy|sad|edge` — happy = the expected flow, sad = the negative/error flow, edge = a boundary case.
- `@variant-<value>` — optional; for a requirement that must hold across a domain axis (channel, tenant, region…).
- Legacy `// @requirement <id>` / `// @path happy` comments above the test still parse as a fallback.

Open the **Coverage** view (the 🎯 pill in the top bar, per selected feature) for the ledger: requirements on the left, tests on the right, synced colour highlighting between them. Coverage is **semantic, not run-gated** — it asks "does a mapped test claim every path (and variant) this requirement implies?", and canary computes the % straight from the tags, so the headline number is math, not an agent's opinion. Gaps:

- **Untested** — no test mapped to the requirement.
- **Path-incomplete** — some paths are claimed, but a sad/edge path has no test.
- **Variant-incomplete** — a variant-bearing requirement is tested on only some of its values (e.g. an "all 4 channels" rule covered by an email-only test).

Depth is graded separately: a **strictness** score rates each covering test by the strongest layer its assertions touch — app log (tier 1), internal state (tier 2), app API (tier 3), or a browser confirming the real effect (tier 4) — labels it shallow/basic/solid/strong, and surfaces the stronger check to write. The `example_todo_api` sample ships an annotated PRD demonstrating all of this.
