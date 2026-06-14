# Canary Lab

[![npm](https://img.shields.io/npm/v/canary-lab.svg)](https://www.npmjs.com/package/canary-lab)
[![license](https://img.shields.io/npm/l/canary-lab.svg)](LICENSE)

**Your AI agent fixes the code. Canary Lab proves it works.**

AI agents are good at editing code and bad at proving the edit works. Canary Lab is the independent harness on your machine: it boots your real services **in dev mode** — no Dockerfiles, no image rebuilds, hot reload intact — runs your Playwright tests itself, and keeps the evidence for every run: service logs, traces, screenshots, videos, the env that was applied. Your agent reads the failure, edits the code (in an isolated git worktree if it's sharing the repo), and signals a rerun; Canary Lab continues from the same run until it's green. Because the harness — not the agent — runs the tests and writes the record, a green run means it actually passed.

![Canary Lab repair loop: failing Playwright test, saved details, AI Agent fix, passing rerun](docs/assets/canary-lab-repair-loop.gif)

**Contents**

- [What's New](#changelog)
- [How the Repair Loop Works](#how-the-repair-loop-works)
- [Why a Harness? Your Agent Already Has a Terminal](#why-a-harness-your-agent-already-has-a-terminal)
- [Canary Lab and docker-compose](#canary-lab-and-docker-compose)
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

## Why a Harness? Your Agent Already Has a Terminal

A good coding agent can start a dev server and run Playwright by itself. Three things it can't do alone:

1. **Run many things at once without conflicts.** Canary Lab gives every run its own free ports and fills them into commands, health checks, and env files (`${port.api}`). If two runs need the same repo, each gets its own git worktree. If too many runs start at once, the extras wait in a queue. Several agents can share one laptop without breaking each other's runs.
2. **Test results the agent can't fake.** Canary Lab starts the services and runs the tests itself. The agent only reads the results and asks for a rerun. So when a run is green, that's Canary Lab's word — not the agent's.
3. **Safe env switching.** Canary Lab backs up your env files before changing them, and puts everything back when the run ends.

## Canary Lab and docker-compose

They work together, not against each other. Compose runs your services as images — so after the agent fixes a line of code, you usually wait for a rebuild before you can test again. Compose Watch can shorten that wait, but only after you write and maintain a dev image and watch rules for every service. Canary Lab skips all of that: it runs the dev commands you already use (`npm run dev`, `./gradlew bootRun`), so a fix is picked up by hot reload and retested in seconds — no Dockerfile needed. And because each run gets its own ports, several runs can share one machine, which compose can't do out of the box.

Compose is still the better tool for databases and queues (Postgres, Redis, Kafka) and for CI. Use both: put `docker compose up postgres redis` in a Canary Lab `startCommand` for the infrastructure, and let Canary Lab run your app services in dev mode.

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
