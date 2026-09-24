# Canary Lab

[![npm](https://img.shields.io/npm/v/canary-lab.svg)](https://www.npmjs.com/package/canary-lab)
[![license](https://img.shields.io/npm/l/canary-lab.svg)](LICENSE)

**Give Claude or Codex an app repo. Get a Playwright evaluation backed by a run the agent cannot mark green itself.**

Your agent investigates the app, writes tests, and fixes application failures. Canary Lab starts the services, runs Playwright, and records the results. You get a report that links requirements, tests, captured evidence, and the actual pass or fail result.

## Quick Start

You need Node.js 22.12 or newer and npm 9 or newer.

1. Create a Canary Lab workspace. This is separate from the app repo you want to test:

   ```bash
   npx canary-lab init my-lab
   ```

   `init` installs the workspace dependencies and Chromium, then registers the Canary Lab skills and one Model Context Protocol (MCP) connection, exposed as `exec`, for supported Claude and Codex clients. The workspace holds test suites and run evidence; your app stays in its own repo.

2. Restart Claude or Codex so it discovers the skill and connection. In its chat, ask it to test a specific flow using your app's absolute path:

   ```text
   /canary-lab /absolute/path/to/your-app "checkout flow"
   ```

3. Follow the Flight (the end-to-end evaluation) in your agent or open the Canary Lab interface. When the report is ready, open its evaluation archive to review the test results and captured evidence. A failed run keeps its failed verdict in the report.

The connection starts the local Canary Lab service when needed. To open the interface yourself:

```bash
cd my-lab
npx canary-lab ui
```

If `/canary-lab` or the Canary Lab `exec` tool is missing, run `npx canary-lab setup --force` from the workspace and restart your agent. Setup reports each saved connection separately; see [configuration repair](docs/COMMANDS.md#repair-agent-configuration) for skill migration, backups, and verification outcomes.

![Canary Lab end-to-end: an AI agent scaffolds a Checkout test suite, checks requirement coverage (47%), authors more tests to reach 100%, runs the suite green (12/12), and exports a verified evaluation report](docs/assets/canary-lab-flight.gif)

## What Happens During a Flight

`/canary-lab` starts one resumable Flight:

scan repo → create suite → collect requirements → author and map tests → run and repair → export evaluation → check readiness for parallel runs

The skill keeps the reasoning work in your current Claude or Codex session. Canary Lab performs the mechanical checks and calculates every stage result from saved evidence.

- **Requirements stay reviewable.** Add a product requirements document, link a local file, gather relevant repo documents, or infer requirements from the branch diff.
- **Coverage is explicit.** Tests map to requirements and paths instead of producing a guessed percentage.
- **Repairs are usually isolated.** Runs use separate Git checkouts when available. Before a suite is prepared for parallel runs, worktree creation failure can make a run use the app's working copy; Canary Lab warns you.
- **Progress survives interruption.** Run `/canary-lab` again with the same repo to continue the existing Flight.
- **The evaluation is the deliverable.** The archive preserves the real verdict, test evidence, any captured browser media, and per-test reasoning. It is available before the separate Parallel setup stage finishes.

## Why the Verdict Is Independent

An agent can propose a fix and say it works. Canary Lab checks that claim with its own Playwright run. The agent can read the evidence and request a rerun, but its statement alone cannot turn a failed run into a pass.

Canary Lab adds:

- **Results the agent does not own.** The harness runs the tests and holds the pass/fail result.
- **Controlled concurrency.** After Canary Lab verifies that the app accepts assigned ports, runs can use separate ports and Git worktrees. Conflicting work waits in a queue.
- **Safe environment switching.** Environment files are backed up before changes and restored when the run ends.

## Choose the Right Skill

Use `/canary-lab` for the complete journey. Use a focused skill when you need only one part:

| Goal | Skill |
| --- | --- |
| Take a bare repo through a complete evaluation | `/canary-lab` |
| Run an existing suite and repair application failures | `/canary-lab-run` |
| Verify a running or deployed environment | `/canary-lab-verify` |
| Create a suite and its Playwright tests | `/canary-lab-author` |
| Build the requirement-to-test coverage ledger | `/canary-lab-coverage` |
| Prepare a suite for concurrent runs | `/canary-lab-portify` |
| Export a completed run as an evaluation | `/canary-lab-export` |

The skills share the same workspace, runs, evidence, and UI. Work started in one surface appears in the others.

## Use the UI or CLI Directly

The agent skill is the normal interactive path. The same Flight can also start from the **Flights** view or from a terminal:

```bash
npx canary-lab flight /absolute/path/to/your-app "checkout flow"
```

Use the CLI for shell automation or when you want Canary Lab to conduct the Flight outside an existing agent conversation. Calling it again follows an active Flight or resumes a paused one. A completed Flight needs `--redo` or `--from-stage` to run again.

The UI and MCP server share one configurable port, `7421` by default. Choose another during setup with `npx canary-lab init my-lab --port 8200`, or change it later in Project Settings. The `ui --port` option is not supported.

Custom MCP clients should connect to `http://localhost:<port>/mcp?profile=compact`.

## Playwright Without a New Test Language

Canary Lab suites use normal Playwright tests plus a service configuration that names your existing development commands. Canary Lab starts each service, waits for health checks, and tags the output so failures map back to the correct test. Once the app is prepared for parallel runs, Canary Lab can assign free ports to concurrent runs.

See [Suite Folders](docs/FEATURES.md) for the file structure and examples, or [Guide](docs/GUIDE.md) for the complete run and repair workflow.

New workspaces include demonstrations for a prepared repair loop, a bare repo Flight, and focused coverage and authoring workflows. Delete the demo files after exploring them.

### Works With Docker Compose

Use Docker Compose for infrastructure such as Postgres or Redis, and let Canary Lab start application services with their normal development commands. This keeps hot reload available during repair.

## How It Compares

| | Plain Playwright | Docker Compose with watch | Hosted dashboard | Canary Lab |
| --- | :---: | :---: | :---: | :---: |
| Runs existing development commands with hot reload | One service | Needs a development image and watch rules | Varies | Yes |
| Boots several services together | You script it | Yes | Varies | Yes |
| Runs concurrently on one machine | Manual | Not built in | Hosted | After port readiness is verified |
| Keeps the run verdict separate from the repair agent's report | Manual | Manual | Varies | Yes |
| Switches environment files with backup and restore | Manual | Manual | No | Yes |
| Keeps harness data on your machine | Yes | Yes | No | Yes |

Use Canary Lab when failures depend on service startup, environment files, backend logs, requirement coverage, or evidence the agent should not control. Plain `npx playwright test` is enough when you do not need orchestration or independent repair evidence. Harness data stays local; repair agents may still need network access.

## Updating a Workspace

With Node.js 22.12 or newer:

```bash
npm install --save-dev canary-lab@latest
npx canary-lab upgrade
```

Restart Canary Lab and connected agent apps afterwards so they load the refreshed skills and connection path. Existing suite folders under `features/` and personal agent files are preserved.

## Requirements

- Node.js 22.12 or newer and npm 9 or newer.
- Chromium for Playwright, installed automatically by `canary-lab init` unless installation is skipped.
- A local UI server, started automatically through the agent connection or manually with `npx canary-lab ui`.
- Optional repair agents: supported Claude or Codex command-line clients on `PATH`.

`node-pty` gives each service a real terminal. Its prebuilt binaries require no normal installation-time compilation. A postinstall step restores the execute bit on its helper binary when needed; it does nothing on Windows or when `node-pty` is absent.

## Limitations

- Repairs are only as useful as your service logs.
- Environment runs overwrite target files while active. If a process is killed during backup or restore, reopen the UI and use the environment controls to recover.
- Environment values are not validated, so stale configuration can surface as unclear failures.
- Linux and Windows workflows are not polished yet.

## Documentation

| Document | What it covers |
| --- | --- |
| [Changelog](docs/CHANGELOG.md) | Release history. |
| [Roadmap](docs/ROADMAP.md) | Planned product milestones and their evidence bars. |
| [Guide](docs/GUIDE.md) | Environment switching, run output, repairs, and evaluation reports. |
| [Commands](docs/COMMANDS.md) | Full CLI and trigger-surface reference. |
| [Suite Folders](docs/FEATURES.md) | Suite structure, configuration, and Playwright tests. |
| [Architecture](docs/ARCHITECTURE.md) | Module map, run lifecycle, concurrency, healing, and MCP. |
| [Product Requirements](docs/PRD.md) | Product intent, non-goals, and quality bars. |
| [Design System](docs/DESIGN-SYSTEM.md) | Web UI tokens, primitives, and layout patterns. |
| [Contributing](docs/CONTRIBUTING.md) | Code orientation and development workflow. |

## License

[MIT](LICENSE)
