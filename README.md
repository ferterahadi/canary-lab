# Canary Lab

[![npm](https://img.shields.io/npm/v/canary-lab.svg)](https://www.npmjs.com/package/canary-lab)
[![license](https://img.shields.io/npm/l/canary-lab.svg)](LICENSE)

The AI repair loop for Playwright.

Canary Lab runs your local Playwright tests, captures the evidence around each failure, and hands your AI agent the context it needs to fix the app and rerun the check. A failed test leaves behind enough to understand what broke and continue from the same run, instead of digging through terminal scrollback. It is built for teams using tests as the spec.

![Canary Lab repair loop: failing Playwright test, saved details, AI Agent fix, passing rerun](docs/assets/canary-lab-repair-loop.gif)

## Repair Loop

1. Canary Lab applies the selected envset and starts your local services.
2. Playwright runs the feature tests.
3. Logs, screenshots, traces, videos, summaries, and failure slices are saved under `logs/runs/<runId>/`.
4. The AI agent reads the failure context, fixes the app or test, and signals `rerun` or `restart`.
5. Canary Lab continues from the same run until the check passes.

## Quick Start

Create a Canary Lab workspace and open the local UI:

```bash
npx canary-lab init my-lab
cd my-lab
npm install
npm run install:browsers
npx canary-lab setup
npx canary-lab ui
```

This creates a workspace with sample features, installs Playwright browsers, registers AI agent tools, and opens the UI at `http://localhost:7421`. Use `npx canary-lab ui --no-open` to skip launching a browser.

After `canary-lab setup`, restart your AI agent so it can discover the Canary Lab tools. If they do not show up, refresh setup and start a fresh agent session with `npx canary-lab setup --force`.

## Agent-First Workflow

Canary Lab is built for an agent-first workflow: an AI agent or other MCP client writes tests, starts or claims runs, reads failure context, makes fixes, and signals the next runner action. Canary Lab stays the local run monitor and source of truth for evidence; the agent is where diagnosis and code changes happen.

From your workspace, just ask:

```text
/canary-lab run checkout locally, fix it if it fails, and run it again until it passes
```

Humans can also start runs from the UI, and custom clients can use the local HTTP API.

## What Canary Lab Owns

Canary Lab has a narrow boundary. It does not define a new test language, assertion model, or browser runner — engineers and agents write normal Playwright tests, and Playwright still executes them. Canary Lab owns the run context around Playwright:

- Feature folder structure and scaffold conventions.
- Envset application and cleanup.
- Service startup, health checks, PTY streams, and shutdown.
- Run manifests, lifecycle events, logs, and retained artifacts.
- Failure slices, summaries, diagnosis journals, and agent handoff prompts.
- Rerun and restart signals after a fix.

Use plain Playwright when one command gives you enough context. Reach for Canary Lab when a failure depends on more than a browser assertion — which services were running, which env files were active, what the backend logged, and which artifacts were produced.

## When to Use It

Good fit when you want to:

- Run e2e tests and have an AI agent fix the application code when they fail.
- Keep logs, screenshots, traces, videos, summaries, and diagnosis notes per run.
- Repair from saved run context instead of terminal scrollback.
- Start a frontend, API, worker, and dependent service together, with each service log attached to the run that used it.
- Run the same feature against `local`, `staging`, or `production` envsets without hand-editing `.env` files.

Probably unnecessary if a plain `npx playwright test` gives you enough context, you want self-healing locators, you do not need service orchestration or env switching, or you want a hosted dashboard that manages tests for you.

## Requirements

- Node.js >= 20 and npm >= 9.
- A modern browser: Chrome, Firefox, or Safari.
- Local UI server on `http://localhost:7421`; service orchestration through `node-pty`.
- Optional repair agents: supported AI agent CLIs (`claude`, `codex`) on `PATH`.

## Feature Folders

A feature lives under `features/<name>/` with `feature.config.cjs`, a Playwright config, specs under `e2e/`, and envsets under `envsets/`.

Create one from the UI or with:

```bash
npx canary-lab new feature checkout-discounts --description "Validate checkout discounts"
```

The UI's Add Test flow can also turn a PRD or uploaded document into a generated plan and Playwright files for review. Generated tests still run through Playwright.

## Commands

```bash
npx canary-lab init <folder>
npx canary-lab setup
npx canary-lab ui
npx canary-lab mcp [--profile repair|verify|author|full]
npx canary-lab mcp doctor [--profile repair|verify|author|full]
npx canary-lab new feature <name> --description "..."
npx canary-lab env apply <feature> <set>
npx canary-lab env revert <feature>
npx canary-lab upgrade
```

- `ui` is the primary human workflow.
- `setup` refreshes the agent/tool registration described in Quick Start.
- `mcp` bridges local AI clients into the UI server, starting it if needed. It defaults to `repair`; use `--profile verify` for deployment checks, `--profile author` for authoring, or `--profile full` for the complete surface.
- `new feature` and `env` are deterministic wrappers for scripts and agents.
- `upgrade` syncs scaffolded docs and skills in an existing project (not a dependency upgrade).

## Repairing a Failed Run

When a run fails, Canary Lab pauses it, waits for a fix, and reruns from the same run — every fix ends in a `rerun` or `restart` signal. Two modes drive the fix:

- **External heal** (default) — an external MCP client claims the run, reads the saved context, and signals the fix over MCP.
- **Auto-heal** — Canary Lab spawns a local `claude`/`codex` CLI in a PTY tab (select Claude or Codex in Settings).

See the [guide](docs/GUIDE.md#repairing-a-failed-run) for the full loop, MCP tool flow, and signal files.

## Limitations

- Repairs depend on useful service logs.
- Envset runs overwrite target files while active. If the process is killed during backup or restore, reopen the UI and use the envset controls to recover.
- Envset values are not validated. Stale config can cause unclear test failures.
- The Linux and Windows workflows are not polished yet.

## Documentation

- [Guide](docs/GUIDE.md) — environment switching, run-output layout, repairing a failed run, evaluation reports, and external authoring.
- [Contributing](docs/CONTRIBUTING.md) — code orientation, run architecture, and the build/test workflow.
- [CHANGELOG.md](docs/CHANGELOG.md) — release notes.

## License

[MIT](LICENSE)
