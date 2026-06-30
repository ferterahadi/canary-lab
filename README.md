# Canary Lab

[![npm](https://img.shields.io/npm/v/canary-lab.svg)](https://www.npmjs.com/package/canary-lab)
[![license](https://img.shields.io/npm/l/canary-lab.svg)](LICENSE)

**Your AI agent implements the code. Canary Lab verifies it independently before it ships.**

Coding agents optimize for the literal instruction — *"tests pass," "done," "fixed"* — which isn't always the same as the code working as intended, and an agent that both writes and grades its own run can mark it green. Canary Lab is the independent harness on your machine: it boots your real services, runs your Playwright tests **itself**, and owns the verdict. Green means it actually passed.

![Canary Lab end-to-end: an AI agent scaffolds a Checkout test suite, checks requirement coverage (47%), authors more tests to reach 100%, runs the suite green (12/12), and exports a verified evaluation report](docs/assets/canary-lab.gif)

**One command, from your workspace:**

```text
/canary-lab run checkout locally, fix it if it fails, and run it again until it passes
```

Boots your services → runs the tests → agent reads the failure, fixes the code, signals a rerun → Canary Lab reruns until green. The agent only reads results and asks for a retry — it never writes the verdict.

## Why the Verdict Is Independent

A good agent can already start a dev server and run Playwright. The gap is trust.

| The agent **can** | The agent **can't** |
| --- | --- |
| Read logs, traces, screenshots, videos | Run the tests itself |
| Fix the app or the test | Declare a run green |
| Signal `rerun` / `restart` | Touch the evidence |

Three things a bare terminal agent can't do alone:

- **Results it doesn't own** — the harness runs the tests and holds the pass/fail.
- **Concurrency without conflicts** — per-run ports (injected as `${port.api}`) + a git worktree per shared repo; extras queue. Several agents share one laptop safely.
- **Safe env switching** — env files are backed up before changes and restored when the run ends.

## What You Write

A feature is a folder with two things: a config for booting your services, and normal Playwright tests — no new test language.

The config is where per-run isolation comes from. Describe the dev command you already run; Canary Lab assigns a free port per run.

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

The tests are ordinary Playwright. The only Canary Lab line is the import — a fixture that tags each test's output so failures map back to the right test:

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

The scaffold ships sample features (some intentionally broken) so you can watch a full repair loop before writing your own.

## How the Repair Loop Works

1. Canary Lab applies the selected envset and starts your local services.
2. Playwright runs the feature tests.
3. Logs, screenshots, traces, videos, summaries, and failure slices land under `logs/runs/<runId>/`.
4. Your agent reads the failure context, fixes the app or the test, and signals `rerun` or `restart` — Canary Lab, not the agent, reruns the tests.
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
| Fully local / offline | ✓ | ✓ | — | ✓ |

Canary Lab earns its place when a failure depends on more than a browser assertion — which services were up, which env was active, what the backend logged — and you want an agent to fix it unattended. Skip it when `npx playwright test` already tells you enough, when you want self-healing locators, or when you'd rather a hosted dashboard manage your tests.

### Works with docker-compose

Compose runs services as images, so a one-line fix waits on a rebuild. Canary Lab runs the dev commands you already use (`npm run dev`, `./gradlew bootRun`): hot reload picks up the fix in seconds, no Dockerfile. Use both — `docker compose up postgres redis` in a Canary Lab `startCommand` for infra, Canary Lab for your app services in dev mode.

## Quick Start

```bash
npx canary-lab init my-lab
cd my-lab
npx canary-lab ui
```

`init` scaffolds a workspace with sample features, installs deps, downloads the Playwright browser, and registers your agent's tools — so `canary-lab ui` opens at `http://localhost:7421` straight away. Add `--no-open` to skip the browser.

CI / offline? Pass `--no-install`, then run the steps manually:

```bash
npx canary-lab init my-lab --no-install
cd my-lab
npm install
npm run install:browsers
npx canary-lab ui
```

The UI and MCP server share one port (default `7421`). Pin another with `--port 8200`, or change it later in Project Settings.

Restart your agent after setup so it discovers the Canary Lab tools. If they don't appear, run `npx canary-lab setup --force` and start a fresh session.

## What Canary Lab Owns

No test language, assertion model, or browser runner — Playwright runs the tests. Canary Lab owns the context around them:

- Feature scaffolding and conventions; envset apply/cleanup.
- Service startup, health checks, PTY streams, shutdown — with per-run port and git-worktree isolation.
- Run manifests, logs, artifacts, failure slices, summaries, and diagnosis journals.
- Rerun/restart signals after a fix.

## Requirements

- Node.js >= 20 and npm >= 9.
- A modern browser: Chrome, Firefox, or Safari.
- Local UI server on `http://localhost:7421` (set per project via `--port` or Project Settings), with orchestration through `node-pty`.
- Optional repair agents: supported AI agent CLIs (`claude`, `codex`) on `PATH`.

`node-pty` is a native module giving each service a real terminal, so interactive dev servers behave as in your own shell. It ships prebuilt binaries — a normal install compiles nothing. One postinstall step (`fix-node-pty-permissions.mjs`) re-adds the execute bit to node-pty's `spawn-helper` ([upstream packaging bug](https://github.com/microsoft/node-pty/issues)); a no-op on Windows or if node-pty isn't installed.

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
| [Contributing](docs/CONTRIBUTING.md) | Code orientation and build/test workflow. |

## License

[MIT](LICENSE)
