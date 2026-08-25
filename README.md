# Canary Lab

[![npm](https://img.shields.io/npm/v/canary-lab.svg)](https://www.npmjs.com/package/canary-lab)
[![license](https://img.shields.io/npm/l/canary-lab.svg)](LICENSE)

📋 **[Changelog](docs/CHANGELOG.md)** — release history, also published on [GitHub Releases](https://github.com/ferterahadi/canary-lab/releases).

**Your AI agent writes the code. Canary Lab verifies it independently.**

Canary Lab is a local evaluation harness for Playwright. It starts your services, runs the tests, stores the evidence, and owns the verdict. Playwright executes tests, the agent writes code, and Canary Lab handles service startup, isolated ports and worktrees, requirement coverage, repair evidence, and the final report. The loop is: **implement → verify → review the report**.

![Canary Lab end-to-end: an AI agent scaffolds a Checkout test suite, checks requirement coverage (47%), authors more tests to reach 100%, runs the suite green (12/12), and exports a verified evaluation report](docs/assets/canary-lab-flight.gif)

**One command, from your product repo:**

```bash
npx canary-lab flight . "checkout flow"
```

Flight creates the suite, checks coverage, prepares isolated ports, runs the tests, repairs application failures, and exports the evaluation. Every stage result comes from saved evidence.

## Why the Verdict Is Independent

An agent can start a dev server and run Playwright. The gap is trust.

| The agent **can** | The agent **can't** |
| --- | --- |
| Read logs, traces, screenshots, videos | Run the tests itself |
| Fix the application, or correct a test only when it is provably wrong | Declare a run green |
| Signal `rerun` / `restart` | Touch the evidence |

Canary Lab adds:

- **Results it doesn't own** — the harness runs the tests and holds the pass/fail.
- **Concurrency without conflicts** — each run gets its own ports and Git worktrees. Repairs do not touch your working copy, and conflicting runs wait in a queue.
- **Safe env switching** — env files are backed up before changes and restored when the run ends.

## What You Write

A feature contains a service config and normal Playwright tests—no new test language. The config uses your existing dev command; Canary Lab assigns each run a free port.

```js
// features/checkout/feature.config.cjs
const config = {
  name: 'checkout',
  envs: ['local'],
  repos: [{
    name: 'checkout',
    localPath: __dirname,
    startCommands: [{
      command: 'npm run dev',
      // A free port per run, injected as PORT, so two runs never collide.
      // Reference it anywhere as ${port.api}.
      ports: [{ name: 'api', env: 'PORT' }],
      healthCheck: { http: { url: 'http://localhost:${port.api}/', timeoutMs: 3000 } },
    }],
  }],
  featureDir: __dirname,
}

module.exports = { config }
```

Tests remain ordinary Playwright. One Canary Lab fixture tags output so failures map to the right test:

```ts
// features/checkout/e2e/checkout.spec.ts
import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'

test('applying SAVE10 produces a 10% discount on the summary', async ({ request }) => {
  const { orderId } = await (await request.post('/order')).json()
  await request.post(`/order/${orderId}/items`, { data: { sku: 'X', qty: 1, price: 100 } })
  await request.post(`/order/${orderId}/coupon`, { data: { code: 'SAVE10' } })
  const summary = await (await request.get(`/order/${orderId}/summary`)).json()
  expect(summary.discount).toBe(10)
})
```

New workspaces include three demonstrations:

- `demo-app/` and `storefront-journey` show the repair loop on a complete suite.
- `flight-app/` has no suite, so Flight must build and verify one from scratch.
- `workflow-app/` and `workflow-workbench` provide focused coverage, authoring, verification, and Portify exercises.

Delete the demo files after you finish exploring them.

## How the Repair Loop Works

1. Canary Lab applies the selected envset and starts your local services.
2. Playwright runs the feature tests.
3. Logs and test artifacts land under `logs/runs/<runId>/`.
4. Your agent reads the failure context, fixes the application, and signals `rerun` or `restart`. It changes a test only when the test is provably wrong.
5. Canary Lab continues from the same run until the check passes.

## How It Compares

| | Plain Playwright | docker-compose (watch) | Hosted dashboard | Canary Lab |
| --- | :---: | :---: | :---: | :---: |
| Runs your existing dev commands, hot reload intact | ✓ | needs dev image + watch rules | — | ✓ |
| Fix → retest in seconds, no rebuild | ✓ (one service) | after rebuild/sync | — | ✓ |
| Boots & orchestrates several services together | you script it | ✓ | varies | ✓ |
| Concurrent runs on one machine (ports + worktrees) | manual | not out of the box | hosted, not local | ✓ |
| Per-run evidence owned by the harness, not the agent | — | — | ✓ (cloud) | ✓ (your machine) |
| Env-file switching with backup/restore | manual | manual | — | ✓ |
| Harness and evidence stay on your machine | ✓ | ✓ | — | ✓ |

Use Canary Lab when failures depend on service startup, environment files, backend logs, or evidence the agent should not control. Plain `npx playwright test` is enough when you do not need orchestration or independent repair evidence. Harness data stays local; repair agents may still need network access.

### Works with docker-compose

Use Docker Compose for infrastructure such as Postgres or Redis, and let Canary Lab start application services with their normal development commands. This keeps hot reload available during repair.

## Quick Start

Point `flight` at a product repo and say what to test:

```bash
npx canary-lab flight ../your-app "checkout flow"
```

`flight` is one resumable background task. Agents propose; Canary Lab verifies. You answer only checkpoints that need a human.

scan → create suite → collect requirements → author tests → prepare ports → run and repair → **export evaluation**

| | Before (manual) | After (`flight`) |
|---|---|---|
| Entry | `init`, learn UI/MCP, then per-feature setup | `npx canary-lab flight ../shop "checkout flow"` |
| feature.config.cjs | hand-written: repos, startCommands, `${port.api}`, healthCheck | agent scouts the repo and drafts it; a dry-run boot verifies it |
| Env → envsets | know + call the capture tool yourself | automatic; missing secrets are the one checkpoint never skipped |
| Docs/PRD | copy files into `docs/`, trigger the summary | the flight pauses for your docs — add files or link local paths (symlinked); else inferred from repo docs / the diff vs your base branch |
| Specs + coverage | author + tag + map by hand | authoring loop until the coverage ledger has no gaps |
| Run + heal + proof | drive the loop, export manually | stages; the flight ends with the evaluation archive on disk |
| Human steps | ~10, expert knowledge required | 1 command + approve checkpoints (`--yolo` skips all but missing secrets) |

Running `flight` again resumes existing work instead of duplicating it. Watch it under **Flights** or invoke the MCP `exec` tool with `start_flight` as its exact `command`.

Contributors can launch that exact tour from this source checkout with:

```bash
npm run demo -- --agent codex
```

`npm run demo` packs the source, creates a retained workspace in the current user's `Canary Lab Demos` folder (`~/Canary Lab Demos/` on macOS/Linux and `%USERPROFILE%\Canary Lab Demos\` on Windows), and opens the shipped UI with repair and Flight demos ready. After stopping the demo, run `npm run demo:clean` to remove retained demos, or `npm run demo:clean -- --older-than 7` to remove only demos at least seven days old. Cleanup skips any demo still named by the live-server or workspace registry so it cannot strand an MCP client on a deleted install. Re-point MCP clients from a non-demo workspace before using `npm run demo:clean -- --force` on registered demos.

`flight` creates the workspace if none exists. To set one up yourself:

```bash
npx canary-lab init my-lab
cd my-lab
npx canary-lab ui
```

`init` creates a workspace with three sample apps and two suites, installs dependencies and Chromium, and registers agent tools. `canary-lab ui` opens the interface; add `--no-open` to keep the browser closed.

CI / offline? Pass `--no-install`, then run the steps manually:

```bash
npx canary-lab init my-lab --no-install
cd my-lab
npm install          # postinstall also downloads the Playwright browser
npx canary-lab ui
```

Upgrading a 1.5.x workspace to 2.0.0 requires Node 22.12 or newer:

```bash
npm install --save-dev canary-lab@2
npx canary-lab upgrade
npx canary-lab ui
```

The 2.0 UI Update button performs the install and upgrade steps together. If you
start from the 1.5.x Update button, restart with Node 22.12+ after it installs
2.0; the first 2.0 startup detects the old workspace stamp and finishes the
migration before serving the UI. Existing feature folders and personal agent
files are preserved. Restart connected agent apps afterwards so they load the
refreshed skills and connection path.

The UI and MCP server share one port, `7421` by default. Choose another during setup with `npx canary-lab init my-lab --port 8200`, or change it later in Project Settings. The `ui --port` option is not supported.

Restart your agent after setup so it discovers the always-loaded Canary Lab `exec` tool. Atomic operations are command values inside it, not separate public tools. If `exec` does not appear, run `npx canary-lab setup --force` and start a fresh session.

## What Canary Lab Owns

No test language, assertion model, or browser runner — Playwright runs the tests. Canary Lab owns the context around them:

- Feature scaffolding and conventions; envset apply/cleanup.
- Service startup, health checks, PTY streams, shutdown — with per-run port and git-worktree isolation.
- Run manifests, logs, artifacts, failure slices, summaries, and diagnosis journals.
- Rerun/restart signals after a fix.

## Requirements

- Node.js >= 22.12 and npm >= 9. (Node 20 reached end-of-life in April 2026.)
- Chromium for Playwright, installed automatically by `canary-lab init` unless installation is skipped.
- A local UI server on port `7421` by default. Set the initial port with `init --port` or change it in Project Settings.
- Optional repair agents: supported AI agent CLIs (`claude`, `codex`) on `PATH`.

`node-pty` gives each service a real terminal. Its prebuilt binaries require no normal install-time compilation. A postinstall step (`fix-node-pty-permissions.mjs`) restores the execute bit on `spawn-helper` ([upstream packaging bug](https://github.com/microsoft/node-pty/issues)); it does nothing on Windows or without `node-pty`.

## Limitations

- Repairs are only as good as your service logs.
- Envset runs overwrite target files while active. If the process is killed mid-backup/restore, reopen the UI and use the envset controls to recover.
- Envset values aren't validated — stale config can surface as unclear failures.
- Linux and Windows workflows aren't polished yet.

## Documentation

| Doc | What's inside |
| --- | --- |
| [Changelog](docs/CHANGELOG.md) | What changed in each release. |
| [Guide](docs/GUIDE.md) | Env switching, run-output layout, repairing a run, evaluation reports, external authoring. |
| [Commands](docs/COMMANDS.md) | Full CLI reference. |
| [Feature Folders](docs/FEATURES.md) | Feature structure, scaffold conventions, creating a feature. |
| [Architecture](docs/ARCHITECTURE.md) | Module map, run lifecycle, concurrency, heal system, MCP layer. |
| [Product Requirements](docs/PRD.md) | Product intent, non-goals, and the quality bars behind review decisions. |
| [Design System](docs/DESIGN-SYSTEM.md) | The web UI's token catalog, primitives, and layout patterns. |
| [Contributing](docs/CONTRIBUTING.md) | Code orientation and build/test workflow. |

## License

[MIT](LICENSE)
