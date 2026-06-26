# Canary Lab

[![npm](https://img.shields.io/npm/v/canary-lab.svg)](https://www.npmjs.com/package/canary-lab)
[![license](https://img.shields.io/npm/l/canary-lab.svg)](LICENSE)

**Your AI agent fixes the code. Canary Lab proves it works.**

AI agents are good at editing code and bad at proving the edit works. Canary Lab is the independent harness on your machine: it boots your real services **in dev mode** — no Dockerfiles, no image rebuilds, hot reload intact — runs your Playwright tests itself, and keeps the evidence for every run: service logs, traces, screenshots, videos, the env that was applied. Your agent reads the failure, edits the code (in an isolated git worktree if it's sharing the repo), and signals a rerun; Canary Lab continues from the same run until it's green. Because the harness — not the agent — runs the tests and writes the record, a green run means it actually passed.

![Canary Lab end-to-end: an AI agent scaffolds a Checkout test suite, checks requirement coverage (47%), authors more tests to reach 100%, runs the suite green (12/12), and exports a verified evaluation report](docs/assets/canary-lab-promo.gif)

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
- [When to Use It](#when-to-use-it)
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

A feature is a folder with two things: a config that says how to boot your services, and normal Playwright tests. There's no new test language to learn.

The config is where the per-run isolation comes from — you describe the dev command you already run, and Canary Lab fills in a free port for each run:

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

The tests are ordinary Playwright. The only Canary Lab-specific line is the import — a thin fixture that tags each test's output in the run log so failures map back to the right test:

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

The scaffold ships working sample features (including some intentionally broken ones) so you can watch a full repair loop before writing your own.

## Why a Harness? Your Agent Already Has a Terminal

A good coding agent can start a dev server and run Playwright by itself. Three things it can't do alone:

1. **Run many things at once without conflicts.** Canary Lab gives every run its own free ports and fills them into commands, health checks, and env files (`${port.api}`). If two runs need the same repo, each gets its own git worktree. If too many runs start at once, the extras wait in a queue. Several agents can share one laptop without breaking each other's runs.
2. **Test results the agent can't fake.** Canary Lab starts the services and runs the tests itself. The agent only reads the results and asks for a rerun. So when a run is green, that's Canary Lab's word — not the agent's.
3. **Safe env switching.** Canary Lab backs up your env files before changing them, and puts everything back when the run ends.

## Canary Lab and docker-compose

They work together, not against each other. Compose runs your services as images — so after the agent fixes a line of code, you usually wait for a rebuild before you can test again. Compose Watch can shorten that wait, but only after you write and maintain a dev image and watch rules for every service. Canary Lab skips all of that: it runs the dev commands you already use (`npm run dev`, `./gradlew bootRun`), so a fix is picked up by hot reload and retested in seconds — no Dockerfile needed. And because each run gets its own ports, several runs can share one machine, which compose can't do out of the box.

Compose is still the better tool for databases and queues (Postgres, Redis, Kafka) and for CI. Use both: put `docker compose up postgres redis` in a Canary Lab `startCommand` for the infrastructure, and let Canary Lab run your app services in dev mode.

## How It Compares

Each of these is the right tool for some jobs. The table is about where Canary Lab's particular niche — an AI agent repairing local, multi-service e2e tests — sits next to them.

| | Plain Playwright | docker-compose (watch) | Hosted test dashboard | Canary Lab |
| --- | :---: | :---: | :---: | :---: |
| Runs your existing dev commands, hot reload intact | ✓ | needs a dev image + watch rules | — | ✓ |
| Fix → retest in seconds, no image rebuild | ✓ (one service) | after rebuild/sync | — | ✓ |
| Boots & orchestrates several services together | you script it | ✓ | varies | ✓ |
| Concurrent runs on one machine (auto ports + git worktrees) | manual | not out of the box | hosted, not local | ✓ |
| Per-run evidence the agent can't fake | — | — | ✓ (in the cloud) | ✓ (on your machine) |
| Env-file switching with backup/restore | manual | manual | — | ✓ |
| Runs fully local / offline | ✓ | ✓ | — | ✓ |

If `npx playwright test` already tells you what you need, or you'd rather a hosted service manage your tests, you don't need Canary Lab. It earns its place when a failure depends on more than a browser assertion — which services were up, which env was active, what the backend logged — and you want an agent to fix it without you babysitting the loop.

## Quick Start

Create a workspace and open the local UI:

```bash
npx canary-lab init my-lab
cd my-lab
npm install
npm run install:browsers
npx canary-lab setup
npx canary-lab ui
```

This scaffolds a workspace with sample features, installs Playwright browsers, registers your AI agent's tools, and opens the UI at `http://localhost:7421`. Add `--no-open` to skip launching a browser.

The UI and MCP server share one port (default `7421`). Pin a different port with `npx canary-lab init my-lab --port 8200`, or change it later in the Project Settings dialog — Canary Lab restarts on the new port, and your MCP client may need to reconnect.

After `canary-lab setup`, restart your AI agent so it discovers the Canary Lab tools. If they don't appear, rerun setup with `npx canary-lab setup --force` and start a fresh agent session.

## Agent-First Workflow

Canary Lab is built for an agent to drive: an AI agent or other MCP client writes tests, starts or claims runs, reads failure context, makes fixes, and signals the next runner action. Canary Lab stays the local run monitor and the source of truth for evidence — diagnosis and code changes happen in the agent.

From your workspace, just ask:

```text
/canary-lab run checkout locally, fix it if it fails, and run it again until it passes
```

You can also start runs by hand from the UI, and custom clients can drive the local HTTP API.

## What Canary Lab Owns

Canary Lab keeps a narrow boundary. It doesn't invent a test language, an assertion model, or a browser runner — you write normal Playwright tests, and Playwright still runs them. What Canary Lab owns is the run context around Playwright:

- Feature folder structure and scaffold conventions.
- Envset application and cleanup.
- Service startup, health checks, PTY streams, and shutdown.
- Per-run port allocation and git-worktree isolation for concurrent runs.
- Run manifests, lifecycle events, logs, and retained artifacts.
- Failure slices, summaries, diagnosis journals, and agent handoff prompts.
- Rerun and restart signals after a fix.

Plain Playwright is enough when one command gives you the whole picture. Reach for Canary Lab when a failure depends on more than a browser assertion — which services were up, which env files were active, what the backend logged, and which artifacts the run produced.

## When to Use It

Canary Lab fits when you want to:

- Let an AI agent fix failing e2e tests while the harness independently reruns them and records the outcome.
- Run several features — or several agents — concurrently, each with isolated ports and worktrees.
- Boot a frontend, API, worker, and dependent service together, with each service's log attached to the run that used it.
- Run one feature against `local`, `staging`, or `production` envsets without hand-editing `.env` files.
- Keep logs, screenshots, traces, videos, summaries, and diagnosis notes per run.

Skip it when `npx playwright test` already tells you enough, when you want self-healing locators, when you don't need service orchestration or env switching, or when you'd rather have a hosted dashboard manage your tests.

## Requirements

- Node.js >= 20 and npm >= 9.
- A modern browser: Chrome, Firefox, or Safari.
- Local UI server on `http://localhost:7421` (the default; set per project via `--port` or Project Settings), with service orchestration through `node-pty`.
- Optional repair agents: supported AI agent CLIs (`claude`, `codex`) on `PATH`.

`node-pty` is a native module — it's how Canary Lab gives each service a real terminal (PTY) so interactive dev servers behave the way they do in your own shell. It ships prebuilt binaries, so a normal install doesn't compile anything. The one postinstall step (`fix-node-pty-permissions.mjs`) only re-adds the execute bit to node-pty's `spawn-helper`, which its npm tarball drops on some platforms ([known upstream packaging bug](https://github.com/microsoft/node-pty/issues)); it's a `chmod`, touches nothing outside `node-modules/node-pty`, and is a silent no-op on Windows or if node-pty isn't installed.

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
