# Canary Lab

[![npm](https://img.shields.io/npm/v/canary-lab.svg)](https://www.npmjs.com/package/canary-lab)
[![license](https://img.shields.io/npm/l/canary-lab.svg)](LICENSE)

**Your AI agent fixes the code. Canary Lab proves it works.**

Canary Lab is the independent harness on your machine: it boots your real services in dev mode, runs your Playwright tests, and keeps the evidence (logs, traces, screenshots, videos). Your agent reads the failure, fixes the code, and signals a rerun — Canary Lab keeps going until it's green. The harness runs the tests and writes the record, so a green run means it actually passed.

![Canary Lab end-to-end: an AI agent scaffolds a Checkout test suite, checks requirement coverage (47%), authors more tests to reach 100%, runs the suite green (12/12), and exports a verified evaluation report](docs/assets/canary-lab.gif)

**Contents**

- [What's New](docs/CHANGELOG.md)
- [How the Repair Loop Works](#how-the-repair-loop-works)
- [What You Write](#what-you-write)
- [Why a Harness? Your Agent Already Has a Terminal](#why-a-harness-your-agent-already-has-a-terminal)
- [Canary Lab and docker-compose](#canary-lab-and-docker-compose)
- [How It Compares](#how-it-compares)
- [Quick Start](#quick-start)
- [Agent-First Workflow](#agent-first-workflow)
- [What Canary Lab Owns](#what-canary-lab-owns)
- [Requirements](#requirements)
- [Limitations](#limitations)
- [Documentation](#documentation)
- [License](#license)

## How the Repair Loop Works

1. Canary Lab applies the selected envset and starts your local services.
2. Playwright runs the feature tests.
3. Logs, screenshots, traces, videos, summaries, and failure slices land under `logs/runs/<runId>/`.
4. Your AI agent reads the failure context, fixes the app or the test, and signals `rerun` or `restart` — Canary Lab, not the agent, reruns the tests.
5. Canary Lab continues from the same run until the check passes.

## What You Write

A feature is a folder with two things: a config for booting your services, and normal Playwright tests — no new test language to learn.

The config is where per-run isolation comes from: you describe the dev command you already run, and Canary Lab assigns a free port per run.

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
      // Canary Lab allocates a free port per run and injects it as PORT, so two
      // runs of this service never collide. Reference it anywhere as ${port.api}.
      ports: [{ name: 'api', env: 'PORT' }],
      healthCheck: { http: { url: 'http://localhost:${port.api}/', timeoutMs: 3000 } },
    }],
  }],
  featureDir: __dirname,
}

module.exports = { config }
```

The tests are ordinary Playwright. The only Canary Lab-specific line is the import — a thin fixture that tags each test's output so failures map back to the right test:

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

## Why a Harness? Your Agent Already Has a Terminal

A good coding agent can start a dev server and run Playwright itself. Three things it can't do alone:

1. **Concurrency without conflicts.** Every run gets its own ports (filled into commands, health checks, and env files via `${port.api}`) and a git worktree per shared repo; extras queue. Several agents share one laptop safely.
2. **Results it can't fake.** The agent only reads results and asks for a rerun — the harness runs the tests and owns the verdict.
3. **Safe env switching.** Env files are backed up before changes and restored when the run ends.

## Canary Lab and docker-compose

They work together. Compose runs services as images, so a one-line fix waits on a rebuild — Compose Watch helps, but only once you maintain a dev image and watch rules per service. Canary Lab runs the dev commands you already use (`npm run dev`, `./gradlew bootRun`): hot reload picks up the fix in seconds, no Dockerfile, and per-run ports let several runs share one machine.

Compose is still better for databases and queues (Postgres, Redis, Kafka) and CI. Use both: `docker compose up postgres redis` in a Canary Lab `startCommand` for infrastructure, Canary Lab for your app services in dev mode.

## How It Compares

Where Canary Lab's niche — an AI agent repairing local, multi-service e2e tests — sits next to the alternatives:

| | Plain Playwright | docker-compose (watch) | Hosted test dashboard | Canary Lab |
| --- | :---: | :---: | :---: | :---: |
| Runs your existing dev commands, hot reload intact | ✓ | needs a dev image + watch rules | — | ✓ |
| Fix → retest in seconds, no image rebuild | ✓ (one service) | after rebuild/sync | — | ✓ |
| Boots & orchestrates several services together | you script it | ✓ | varies | ✓ |
| Concurrent runs on one machine (auto ports + git worktrees) | manual | not out of the box | hosted, not local | ✓ |
| Per-run evidence the agent can't fake | — | — | ✓ (in the cloud) | ✓ (on your machine) |
| Env-file switching with backup/restore | manual | manual | — | ✓ |
| Runs fully local / offline | ✓ | ✓ | — | ✓ |

Canary Lab earns its place when a failure depends on more than a browser assertion — which services were up, which env was active, what the backend logged — and you want an agent to fix it unattended. Skip it when `npx playwright test` already tells you enough, when you want self-healing locators, when you don't need service orchestration or env switching, or when you'd rather a hosted dashboard manage your tests.

## Quick Start

Create a workspace and open the local UI:

```bash
npx canary-lab init my-lab
cd my-lab
npx canary-lab ui
```

`init` scaffolds a workspace with sample features, installs dependencies, downloads the Playwright browser, and registers your AI agent's tools — so `canary-lab ui` opens the UI at `http://localhost:7421` straight away. Add `--no-open` to skip the browser.

Prefer to install yourself (CI / offline)? Pass `--no-install` to `init`, then run the steps manually:

```bash
npx canary-lab init my-lab --no-install
cd my-lab
npm install
npm run install:browsers
npx canary-lab ui
```

The UI and MCP server share one port (default `7421`). Pin another with `--port 8200` on `init`, or change it later in Project Settings — Canary Lab restarts on the new port, and your MCP client may need to reconnect.

Restart your AI agent after setup so it discovers the Canary Lab tools. If they don't appear, run `npx canary-lab setup --force` and start a fresh agent session.

## Agent-First Workflow

Canary Lab is built for an agent to drive: an MCP client writes tests, starts or claims runs, reads failure context, fixes code, and signals the next action. Canary Lab stays the run monitor; diagnosis and edits happen in the agent.

From your workspace, just ask:

```text
/canary-lab run checkout locally, fix it if it fails, and run it again until it passes
```

You can also start runs by hand from the UI, and custom clients can drive the local HTTP API.

## What Canary Lab Owns

Canary Lab keeps a narrow boundary: no test language, assertion model, or browser runner — Playwright runs the tests. Canary Lab owns the context around them:

- Feature scaffolding and conventions; envset apply/cleanup.
- Service startup, health checks, PTY streams, shutdown — with per-run port and git-worktree isolation for concurrent runs.
- Run manifests, logs, artifacts, failure slices, summaries, and diagnosis journals.
- Rerun/restart signals after a fix.

## Requirements

- Node.js >= 20 and npm >= 9.
- A modern browser: Chrome, Firefox, or Safari.
- Local UI server on `http://localhost:7421` (the default; set per project via `--port` or Project Settings), with service orchestration through `node-pty`.
- Optional repair agents: supported AI agent CLIs (`claude`, `codex`) on `PATH`.

`node-pty` is a native module that gives each service a real terminal (PTY), so interactive dev servers behave as they do in your own shell. It ships prebuilt binaries — a normal install compiles nothing. The one postinstall step (`fix-node-pty-permissions.mjs`) re-adds the execute bit to node-pty's `spawn-helper`, which its tarball drops on some platforms ([upstream packaging bug](https://github.com/microsoft/node-pty/issues)): a `chmod` scoped to `node_modules/node-pty`, a silent no-op on Windows or if node-pty isn't installed.

## Limitations

- Repairs are only as good as your service logs.
- Envset runs overwrite target files while active. If the process is killed mid-backup or mid-restore, reopen the UI and use the envset controls to recover.
- Envset values aren't validated — stale config can surface as unclear test failures.
- The Linux and Windows workflows aren't polished yet.

## Documentation

| Doc | What's inside |
| --- | --- |
| [Changelog](docs/CHANGELOG.md) | What changed in each release. |
| [Guide](docs/GUIDE.md) | Environment switching, run-output layout, repairing a failed run, evaluation reports, and external authoring. |
| [Commands](docs/COMMANDS.md) | Full CLI reference for every `canary-lab` subcommand. |
| [Feature Folders](docs/FEATURES.md) | Feature structure, scaffold conventions, and creating a feature. |
| [Architecture](docs/ARCHITECTURE.md) | Module map, run lifecycle, concurrency, heal system, and the MCP layer. |
| [Contributing](docs/CONTRIBUTING.md) | Code orientation and the build/test workflow. |

## License

[MIT](LICENSE)
