# Feature Folders

This document describes a Canary Lab feature folder. See the [README](../README.md) for setup and the main workflow.

A feature lives under `features/<name>/`. It contains `feature.config.cjs`, a Playwright config, tests under `e2e/`, and environment sets under `envsets/`.

Create one from the UI or with:

```bash
npx canary-lab new feature checkout-discounts --description "Validate checkout discounts"
```

Flight can create the feature and turn requirement documents into tagged Playwright tests. It continues until the coverage target is met or the authoring loop needs your decision. External MCP clients can use `start_external_draft` → `apply_external_draft` to submit tests they authored themselves.

## Requirement Coverage

A feature can keep specifications, tickets, and notes in `docs/`. Canary Lab summarizes those Markdown files into requirements with stable IDs. It stores the machine-readable summary in `_prd-summary.json` and a readable copy in `_prd-summary.md`. Regeneration preserves IDs for requirements that still exist, so test tags remain valid.

Tie tests to requirements with Playwright tags **on** the `test()` (greppable, rename-proof):

```ts
test('DELETE /todos/:id removes a todo', { tag: ['@req-R3', '@path-happy'] }, async () => { /* ... */ })
```

- `@req-<id>` — repeatable; a test may cover several requirements.
- `@path-happy|sad|edge` — happy = the expected flow, sad = the negative/error flow, edge = a boundary case.
- `@variant-<value>` — optional; for a requirement that must hold across a domain axis (channel, tenant, region…).
- Legacy `// @requirement <id>` / `// @path happy` comments above the test still parse as a fallback.

Open **Coverage** from a row in the Suites column. The ledger maps requirements to tests and calculates coverage from tags. It measures whether every required path and variant has a mapped test; it does not depend on the latest run result. Gap labels mean:

- **Untested** — no test mapped to the requirement.
- **Path-incomplete** — some paths are claimed, but a sad/edge path has no test.
- **Variant-incomplete** — a variant-bearing requirement is tested on only some of its values (e.g. an "all 4 channels" rule covered by an email-only test).

Coverage depth is separate. The **strictness** score grades the strongest assertion layer: application log, internal state, application API, or a browser confirming the real result. Canary Lab labels the test shallow, basic, solid, or strong and suggests a stronger check when possible.
