# Canary Lab

[![npm](https://img.shields.io/npm/v/canary-lab.svg)](https://www.npmjs.com/package/canary-lab)
[![license](https://img.shields.io/npm/l/canary-lab.svg)](LICENSE)

**The AI repair loop for Playwright.**

A failing Playwright test scatters its evidence — service logs in one terminal, a trace file somewhere, a screenshot you have to go find. Canary Lab keeps the whole run in one place. It runs your tests locally, captures the context around each failure — logs, screenshots, traces, videos, which services were running, which env was applied — and hands that to your AI agent to fix the app and rerun from the same run. Built for teams that use tests as the spec.

![Canary Lab repair loop: failing Playwright test, saved details, AI Agent fix, passing rerun](docs/assets/canary-lab-repair-loop.gif)

**Contents**

- [How the Repair Loop Works](#how-the-repair-loop-works)
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
4. Your AI agent reads the failure context, fixes the app or the test, and signals `rerun` or `restart`.
5. Canary Lab continues from the same run until the check passes.

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
- Run manifests, lifecycle events, logs, and retained artifacts.
- Failure slices, summaries, diagnosis journals, and agent handoff prompts.
- Rerun and restart signals after a fix.

Plain Playwright is enough when one command gives you the whole picture. Reach for Canary Lab when a failure depends on more than a browser assertion — which services were up, which env files were active, what the backend logged, and which artifacts the run produced.

## When to Use It

Canary Lab fits when you want to:

- Run e2e tests and let an AI agent fix the application code when they fail.
- Keep logs, screenshots, traces, videos, summaries, and diagnosis notes per run.
- Repair from saved run context instead of terminal scrollback.
- Boot a frontend, API, worker, and dependent service together, with each service's log attached to the run that used it.
- Run one feature against `local`, `staging`, or `production` envsets without hand-editing `.env` files.

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
| [Guide](docs/GUIDE.md) | Environment switching, run-output layout, repairing a failed run, evaluation reports, and external authoring. |
| [Commands](docs/COMMANDS.md) | Full CLI reference for every `canary-lab` subcommand. |
| [Feature Folders](docs/FEATURES.md) | Feature structure, scaffold conventions, and creating a feature. |
| [Architecture](docs/ARCHITECTURE.md) | Module map, run lifecycle, concurrency, heal system, and the MCP layer. |
| [Contributing](docs/CONTRIBUTING.md) | Code orientation and the build/test workflow. |
| [Changelog](docs/CHANGELOG.md) | Release notes. |

## License

[MIT](LICENSE)
