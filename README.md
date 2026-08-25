# Canary Lab

[![npm](https://img.shields.io/npm/v/canary-lab.svg)](https://www.npmjs.com/package/canary-lab)
[![license](https://img.shields.io/npm/l/canary-lab.svg)](LICENSE)

**Give Claude or Codex a repo. Get an independently verified Playwright evaluation.**

Run this in your agent after the one-time setup below:

```text
/canary-lab /absolute/path/to/your-app "checkout flow"
```

The `/canary-lab` skill takes the repo from first scan to finished evaluation. Your agent understands the code, gathers requirements, writes tests, and repairs application failures. Canary Lab starts the services, runs Playwright, stores the evidence, and owns the verdict.

![Canary Lab end-to-end: an AI agent scaffolds a Checkout test suite, checks requirement coverage (47%), authors more tests to reach 100%, runs the suite green (12/12), and exports a verified evaluation report](docs/assets/canary-lab-flight.gif)

## Set Up Once

Canary Lab requires Node.js 22.12 or newer and npm 9 or newer.

```bash
npx canary-lab init my-lab
```

`init` creates a Canary Lab workspace, installs its dependencies and Chromium, and registers the skills and MCP connection for supported Claude and Codex clients. Restart your agent once so it discovers them.

The connection starts the local Canary Lab service when the skill needs it. To open the interface yourself:

```bash
cd my-lab
npx canary-lab ui
```

If `/canary-lab` or the Canary Lab `exec` tool is missing, run `npx canary-lab setup --force` from the workspace and restart your agent.

## What Happens During a Flight

`/canary-lab` starts one resumable Flight:

scan repo → create suite → collect requirements → author and map tests → prepare isolated ports → run and repair → export evaluation

The skill keeps the reasoning work in your current Claude or Codex session. Canary Lab performs the mechanical checks and calculates every stage result from saved evidence.

- **Requirements stay reviewable.** Add a product requirements document, link a local file, gather relevant repo documents, or infer requirements from the branch diff.
- **Coverage is explicit.** Tests map to requirements and paths instead of producing a guessed percentage.
- **Repairs stay isolated.** Each run receives its own ports and Git worktree, so repairs do not alter your working copy.
- **Progress survives interruption.** Run `/canary-lab` again with the same repo to continue the existing Flight.
- **The evaluation is the deliverable.** The final archive contains the real verdict, test evidence, browser media, and per-test reasoning.

## Why the Verdict Is Independent

An agent can start a server and run Playwright itself. The gap is trust: the same actor that writes a fix should not be able to declare that fix correct.

| The agent can | The agent cannot |
| --- | --- |
| Read logs, traces, screenshots, and videos | Run Canary Lab's tests itself |
| Fix the application, or correct a test only when it is provably wrong | Declare a run green |
| Signal `rerun` or `restart` | Change Canary Lab's saved evidence |

Canary Lab adds:

- **Results the agent does not own.** The harness runs the tests and holds the pass/fail result.
- **Concurrency without conflicts.** Runs receive isolated ports and Git worktrees; conflicting work waits in a queue.
- **Safe environment switching.** Environment files are backed up before changes and restored when the run ends.

## Choose the Right Skill

Use `/canary-lab` for the complete journey. Use a focused skill when you need only one part:

| Goal | Skill |
| --- | --- |
| Take a bare repo through a complete evaluation | `/canary-lab` |
| Run an existing suite and repair application failures | `/canary-lab-run` |
| Verify a running or deployed environment | `/canary-lab-verify` |
| Create a feature and its Playwright tests | `/canary-lab-author` |
| Build the requirement-to-test coverage ledger | `/canary-lab-coverage` |
| Prepare a feature for concurrent runs | `/canary-lab-portify` |
| Export a completed run as an evaluation | `/canary-lab-export` |

The skills share the same workspace, runs, evidence, and UI. Work started in one surface appears in the others.

## Use the UI or CLI Directly

The agent skill is the normal interactive path. The same Flight can also start from the **Flights** view or from a terminal:

```bash
npx canary-lab flight /absolute/path/to/your-app "checkout flow"
```

Use the CLI for shell automation or when you want Canary Lab to conduct the Flight outside an existing agent conversation. Running the command again resumes existing work instead of creating a duplicate.

The UI and MCP server share one configurable port, `7421` by default. Choose another during setup with `npx canary-lab init my-lab --port 8200`, or change it later in Project Settings. The `ui --port` option is not supported.

## Playwright Without a New Test Language

Canary Lab features use normal Playwright tests plus a service configuration that names your existing development commands. Canary Lab assigns free ports, starts each service, waits for health checks, and tags the output so failures map back to the correct test.

See [Feature Folders](docs/FEATURES.md) for the file structure and examples, or [Guide](docs/GUIDE.md) for the complete run and repair workflow.

New workspaces include demonstrations for a prepared repair loop, a bare repo Flight, and focused coverage and authoring workflows. Delete the demo files after exploring them.

### Works With Docker Compose

Use Docker Compose for infrastructure such as Postgres or Redis, and let Canary Lab start application services with their normal development commands. This keeps hot reload available during repair.

## How It Compares

| | Plain Playwright | Docker Compose with watch | Hosted dashboard | Canary Lab |
| --- | :---: | :---: | :---: | :---: |
| Runs existing development commands with hot reload | One service | Needs a development image and watch rules | Varies | Yes |
| Boots several services together | You script it | Yes | Varies | Yes |
| Runs concurrently on one machine | Manual | Not built in | Hosted | Isolated ports and worktrees |
| Keeps evidence outside the repair agent's control | No | No | Yes | Yes, locally |
| Switches environment files with backup and restore | Manual | Manual | No | Yes |
| Keeps harness data on your machine | Yes | Yes | No | Yes |

Use Canary Lab when failures depend on service startup, environment files, backend logs, requirement coverage, or evidence the agent should not control. Plain `npx playwright test` is enough when you do not need orchestration or independent repair evidence. Harness data stays local; repair agents may still need network access.

## Updating a Workspace

With Node.js 22.12 or newer:

```bash
npm install --save-dev canary-lab@latest
npx canary-lab upgrade
```

Restart Canary Lab and connected agent apps afterwards so they load the refreshed skills and connection path. Existing feature folders and personal agent files are preserved.

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
| [Guide](docs/GUIDE.md) | Environment switching, run output, repairs, and evaluation reports. |
| [Commands](docs/COMMANDS.md) | Full CLI and trigger-surface reference. |
| [Feature Folders](docs/FEATURES.md) | Feature structure, configuration, and Playwright tests. |
| [Architecture](docs/ARCHITECTURE.md) | Module map, run lifecycle, concurrency, healing, and MCP. |
| [Product Requirements](docs/PRD.md) | Product intent, non-goals, and quality bars. |
| [Design System](docs/DESIGN-SYSTEM.md) | Web UI tokens, primitives, and layout patterns. |
| [Contributing](docs/CONTRIBUTING.md) | Code orientation and development workflow. |

## License

[MIT](LICENSE)
