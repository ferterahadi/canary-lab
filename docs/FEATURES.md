# Suite Folder Reference

A Canary Lab suite is the unit that one run executes. It connects product
repositories and service start commands to Playwright tests, environment files,
and requirement evidence. Suites live under `features/<name>/`.

The on-disk, CLI, REST, and Model Context Protocol (MCP) contracts retain the
established `feature` name for compatibility. Literal names such as
`feature.config.cjs`, `npx canary-lab new feature`, `/api/features`, and a
`feature` argument do not change when the UI calls the same object a suite.

See the [README](../README.md) for workspace setup and the [Guide](GUIDE.md) for
running, repairing, and exporting a suite.

## Create a suite

Create a deterministic starter from the UI or CLI:

```bash
npx canary-lab new feature checkout-discounts --description "Validate checkout discounts"
```

The scaffold contains `feature.config.cjs`, a Playwright config, envset metadata, a
local envset, and an example spec. Replace the example with real behavior.

Flight can build the same structure from one or more product repos, collect
requirements, author and map tests, prepare services for concurrent ports, run
the suite, repair failures, and export the evaluation. An external MCP client
can instead author specs through `start_external_draft` →
`update_external_draft_stage` → `apply_external_draft`.

## Readable tests

The Test Ledger and Coverage Ledger open each Playwright test in English by
default. Choose **Code** to see the original source. Selecting an English node
opens Code at that node's exact file and line range; helper steps can point to a
different source file from the test that called them.

Canary Lab builds this representation deterministically while it parses the
current test source:

- Playwright actions, assertions, and semantic locators use fixed syntax rules.
- Literal `test.step` labels stay authored text. Helpers, branches, switch
  paths, and all JavaScript loop forms stay nested instead of being flattened.
- Every node records whether its wording is authored, rule-derived, or
  unresolved. Unresolved syntax shows the exact source snippet immediately.
- No LLM request is made, and no translation sidecar is stored. Existing tests
  receive the English view automatically the next time the tests payload is
  extracted; each screen only keeps its normal in-memory fetch cache.
- Pass, fail, running, and changed-test states remain attached to the real test.
  Static English child nodes never claim execution evidence they do not have.

## Discovery errors

The Tests panel lists cases with Playwright before displaying them. If a config
or import fails, choose **In Canary Lab** to run the configured repair agent, or
copy `/canary-lab-repair-discovery <suite>` from **In your agent** into Claude or
Codex with the Canary Lab skills and MCP connection installed.

Both paths show progress in the same Tests column through the shared agent session
viewer. External agents claim the repair and report milestones to Canary; updates
appear without refreshing, including when the repair started outside the browser.
After editing stops, Canary independently lists the tests. Success brings back the
existing test list; failure brings back the error and repair actions. Repair history
remains available. **Copy repair prompt**, **View repair prompt**, and **Retry
discovery** also support manual recovery.

Repairs preserve tests and assertions and address configuration or import failures.
Verification runs discovery only. The previous run's counts remain execution history;
listing cases does not run them. Lost contact with an external agent does not release
its ownership: continue that session, or have it stop and report that it is blocked.

Keep runtime credential reads and service connections in hooks or fixtures so
discovery works before environment setup. Use persistent repository paths in suite
configuration and envset targets, and resolve repo-owned files through
`resolveRunRepoPath` when a run may use an isolated checkout.

## Folder layout

```text
features/<name>/
├── feature.config.cjs
├── playwright.config.ts
├── e2e/
│   └── <name>.spec.ts
├── envsets/
│   ├── envsets.config.json
│   └── <environment>/
│       └── <slot file>
├── docs/                         optional requirement sources
│   ├── <source>.md
│   ├── _prd-summary.json         generated structured requirements
│   └── _prd-summary.md           generated readable summary
├── portify/                      optional saved port overlay
└── verification.configs.json    optional deployed targets
```

| Path | Purpose |
| --- | --- |
| `feature.config.cjs` | Suite name, environments, repositories, service commands, readiness checks, and optional port slots |
| `playwright.config.ts` | Playwright execution and artifact policy for this suite |
| `e2e/*.spec.ts` | Tests executed by the suite |
| `envsets/envsets.config.json` | Maps named slot files to their target paths and defines the test command |
| `envsets/<environment>/` | Values temporarily applied for a selected environment |
| `docs/` | Source requirements and generated PRD summary sidecars |
| `portify/` | Verified patches that make service ports injectable; applied only in run worktrees |
| `verification.configs.json` | Saved deployed-environment verification inputs |

## Suite configuration

`feature.config.cjs` exports `{ config }`. A repository may start several
services. Each structured start command can declare a readiness check, restrict
itself to selected environments, and expose injectable port slots:

```js
const path = require('node:path')

const appDir = path.join(__dirname, '..', '..', 'checkout-api')

const config = {
  name: 'checkout-discounts',
  description: 'Validate checkout discount behavior',
  envs: ['local', 'production'],
  repos: [{
    name: 'checkout-api',
    localPath: appDir,
    envs: ['local'],
    startCommands: [{
      name: 'api',
      command: 'npm run dev',
      ports: [{ name: 'api', env: 'PORT' }],
      healthCheck: { http: { url: 'http://127.0.0.1:${port.api}/health' } },
    }],
  }],
  featureDir: __dirname,
}

module.exports = { config }
```

Canary Lab allocates each declared slot per run, injects the configured env var,
and resolves `${port.<name>}` in start commands, readiness checks, and applied
envset files. A saved Portify overlay is still required when the application
source itself ignores the injected value.

Use repository- or command-level `envs: ['local']` to skip local services when
the selected envset points Playwright at a deployed URL.

## Requirement coverage

Put specifications, tickets, and distilled notes in `docs/`. Canary Lab turns
the source collection into `_prd-summary.json` and `_prd-summary.md`. Surviving
requirements keep their IDs across regeneration; removed requirements remain
deprecated so existing test tags do not silently point at a different meaning.

Map a test with Playwright tags on the `test()` call:

```ts
test('DELETE /todos/:id removes a todo', {
  tag: ['@req-R3', '@path-happy'],
}, async () => {
  // ...
})
```

- `@req-<id>` maps the test to a requirement. It is repeatable.
- `@path-happy`, `@path-sad`, and `@path-edge` state which expected,
  error, or boundary paths the test exercises.
- `@variant-<value>` claims a value from the suite's optional variant
  dimension, such as channel, tenant, region, role, or plan.
- Legacy `@requirement`, `@path`, and `@variant` comments immediately above a
  test still parse as a migration fallback.

The headline coverage percentage is claim-based. A requirement is covered only
when mapped tests claim every required path and every applicable
path-by-variant cell. It does not become covered merely because a test passed.

| Gap | Meaning |
| --- | --- |
| `untested` | No test maps to the requirement |
| `path-incomplete` | At least one required happy, sad, or edge path is unclaimed |
| `variant-incomplete` | At least one applicable path-by-variant cell is unclaimed |
| `covered` | Every required path, or every applicable path-by-variant cell, is claimed |

When the suite has run, the ledger adds a separate **proven** view from the
latest run. A mapped test can therefore claim coverage while its requirement
remains unproven because the test failed or did not run. This latest-run overlay
does not change the claim-based gap types or coverage percentage.

The ledger's time axis places each requirement's proof against its changes.
Three timestamps are read from the run records at request time — when a run
last passed every mapped test, when a mapped test last changed (with the
verification-strength verdict), and when the wording last changed — and derive
one state:

| State | Meaning |
| --- | --- |
| `proven-unchanged` | The proof is newer than both the tests' and the wording's last change |
| `tests-weakened` | A mapped test was classified weaker after the proof |
| `proof-stale` | A mapped test changed after the proof, or no run ever proved it |
| `wording-ahead` | The wording changed after the tests and the proof |

A human can accept a requirement's wording from the ledger; the acceptance is
recorded with the wording's fingerprint, so a later change shows as outdated.

Coverage depth is separate from both. Canary Lab classifies the strongest
assertion layer in each test—application log, internal state, application API or
UI, or a real external destination—and labels it `shallow`, `basic`, `solid`, or
`strong`.
