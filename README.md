# Canary Lab

[![npm](https://img.shields.io/npm/v/canary-lab.svg)](https://www.npmjs.com/package/canary-lab)
[![license](https://img.shields.io/npm/l/canary-lab.svg)](LICENSE)

Canary Lab is a local harness I built around Playwright so I can hand a failing test to Claude or Codex and walk away.

I wanted an inner loop where I describe a feature, the tests run, an agent reads the failure, fixes the code, and tries again — without me in the middle. Playwright already tells me what failed; the agent already knows how to fix things. Canary Lab is the plumbing in between.

It only works because three other things keep getting better. Playwright keeps catching things I'd miss. Claude and Codex keep getting better at reading evidence and editing code. node-pty and the surrounding ecosystem make the orchestration boring. I didn't build the hard parts — I'm assembling them.

[![Canary Lab UI walkthrough](docs/assets/canary-lab-ui-walkthrough.png)](docs/assets/canary-lab-ui-walkthrough.gif)

See [CHANGELOG.md](CHANGELOG.md) for what's new in each release.

## Mental Model

Playwright is still the test runner. Canary Lab is the workspace around the run.

A typical failure is rarely just a failed assertion. It may depend on which env file was active, whether the local services were healthy, what the backend logged while the test was running, and which screenshot, trace, or video Playwright produced. Canary Lab keeps those pieces together for each run so the next step is based on the actual local state, not a pasted error message.

Canary Lab owns the surrounding workflow:

- start the services a feature needs, wait for them to be ready, and stop them cleanly
- apply the selected envset across the local repos involved in the run
- keep service logs, Playwright output, screenshots, videos, traces, and event history under one run
- separate logs by test so a failure points at the relevant window of activity
- give a human or agent a shared place to review evidence, write diagnosis notes, and request a rerun or restart

Canary Lab does not replace Playwright or hide its output. It keeps Playwright visible, then adds the local system context needed to debug the result.

## Who This Is For

Use this if:

- your tests depend on more than one local app or service
- you often switch env files during local testing
- you want failure context collected in one place
- you want Claude Code or Codex to work from logs and summaries instead of only a pasted test failure

## Who This Is Not For

This is probably not for you if:

- you only test a single app
- normal Playwright fixtures, reporters, and scripts are enough
- you need Linux or Windows support today
- you want a CI-first tool rather than a local development workflow

## Current Scope

- **Cross-platform.** Services and the heal agent run inside `node-pty` — no AppleScript, no iTerm, no Terminal.app. The web UI streams those PTYs into your browser.
- **Node.js ≥ 20**, **npm ≥ 9**.
- A modern browser (Chrome / Firefox / Safari) for the local UI on `http://localhost:7421`.
- **Optional, for headless auto-heal:** [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude`) or [Codex CLI](https://github.com/openai/codex) (`codex`) on `PATH`.

## Quick Start

```bash
npx canary-lab init my-lab
cd my-lab
npm install
npm run install:browsers
npx canary-lab ui
```

`canary-lab ui` boots a local Fastify server on `http://localhost:7421` and opens it in your default browser. The UI is a 3-column Finder-style layout:

1. **Features** — every `features/<name>/` discovered in the project, with a "Run" button per feature.
2. **Runs** — the last 20 runs preserved under `logs/runs/<runId>/`, each with status, timing, and per-test results.
3. **Run detail** — overview, service PTYs, Playwright terminal/playback, heal-agent output, and the selected run's diagnosis journal.

Pass `--no-open` to suppress the browser auto-launch (useful over SSH or in CI). Pass `--port <n>` to bind a different port:

```bash
npx canary-lab ui --port 8123
```

`canary-lab init` scaffolds four sample features (`example_todo_api`, `broken_todo_api`, `tricky_checkout_api`, `flaky_orders_api`) so you can try the heal workflow before bringing your own services.

## Commands

```bash
npx canary-lab init <folder>
npx canary-lab ui # primary surface (web UI)
npx canary-lab ui --port 8123 # use a custom UI port
npx canary-lab new feature <name> --description "..."
npx canary-lab env apply <feature> <set>
npx canary-lab env revert <feature>
npx canary-lab upgrade
```

The `new feature` and `env` commands are deterministic wrappers for agents and scripts. The web UI remains the primary human workflow for creating features, editing envsets, running tests, and reviewing results.

`canary-lab upgrade` is for syncing scaffolded docs and skills in an existing project with the current package version. It is not a general dependency or repo upgrade system.

## Environment Switching

The web UI manages temporary environment files for a feature. In the Envsets tab, create an env, add the files that should be swapped during a run, edit their values, and start the run from the UI. Canary Lab stores envsets under `features/<feature>/envsets/`, backs up the target files at the start of each run, and restores them afterward.

If setting envsets up by hand feels tedious, the scaffolded project ships an `Env Import` skill (`.claude/skills/env-import.md`). Ask Claude or Codex to "import env files for [feature]" and the agent copies the relevant `.env` files from the repos declared in `feature.config.cjs` into the feature's envsets.

### Environment variable safety

Envset files often contain credentials, API keys, and database passwords copied from local app configs. The default `.gitignore` ignores `features/*/envsets/*/*` to prevent accidental commits. If you override this or use `git add -f`, review what you are committing — don't push real credentials to shared or public repositories.

## What Gets Written Per Run

Each run gets its own directory under `logs/runs/<runId>/`. The exact contents depend on the feature, whether Playwright ran, and whether a heal cycle was started, but the main paths are:

- `manifest.json` — run metadata, selected feature, service status, repo snapshots, artifact policy, and signal paths
- `runner.log` — orchestration events such as service startup, health checks, Playwright start/exit, detected signals, and cleanup
- `svc-*.log` — stdout/stderr captured from each started service
- `playwright.log` — raw Playwright stdout/stderr from the run
- `playwright-events.jsonl` — structured test and browser-action events used by Playback
- `playwright-artifacts/` — Playwright output directory for retained screenshots, videos, traces, and attachments
- `e2e-summary.json` — current test state, failed tests, and failure context written by the summary reporter
- `failed/<slug>/` — per-failure slices and, when available, Playwright MCP captures for that failure
- `heal-index.md` — compact failure index for human or agent-driven repair, written when failures are enriched
- `diagnosis-journal.md` — heal-cycle hypotheses, changed files, signals, and outcomes when healing has run
- `agent-transcript.log` — raw Claude or Codex output when auto-heal runs
- `signals/` — `.heal`, `.rerun`, and `.restart` files used to pause, rerun tests, or restart affected services

Outside the run directory, `logs/runs/index.json` tracks run history and `logs/current/` points at the active run so manual agents can use stable paths while the UI keeps the full run history.

## Assertion Review

Each completed run can export a single-page **Assertion Review** for the feature it ran — the "Export Assertion" button in the run detail Overview tab. The download is a `.zip` containing one HTML file, per-test flowchart SVGs, and any captured videos.

![Assertion Review sample](docs/assets/assertion-review.png)

Each test case lists its body, the helpers it calls (with local helper definitions inlined once), and every assertion. Each assertion is graded **strict / moderate / shallow / unknown** by static analysis — a string-equality check on a business-critical field grades strict; `toBeVisible()` grades moderate; an existence-or-count check grades shallow.

The intended use is PR review. A green run says the suite passed; the assertion review says what it actually proved. Attach it to a PR so the reviewer — human or agent — can decide whether the assertions match what the change is supposed to deliver.

## Self-Fixing Workflow

When a test fails, an agent fixes the code. The scaffolded project ships with `CLAUDE.md` and `AGENTS.md` containing the managed `heal-prompt` section both flavors point at `logs/current/...`. After a fix, the agent writes one of the active run's signal files: `signals/.restart` for service or app changes, `signals/.rerun` for test/config-only changes.

### Auto-heal

The runner spawns a Claude or Codex agent in its own PTY tab inside the web UI when a test fails. Canary Lab renders its packaged `apps/web-server/prompts/heal-agent.md` template with the active run's exact file paths and passes that prompt to the agent. Output is filtered through a formatter so you see readable progress instead of raw stream-json.

Auto-heal is capped by the runner — the current default is 3 heal cycles. If auto-heal gives up, exits without a signal, or no Claude/Codex CLI is available, the run finishes as failed; start another run or switch the project to Manual before retrying the hand-driven loop.

### Manual heal

Set the project heal agent to **Manual** when you want to drive the fix yourself. A failing run stays in the healing state and waits for a signal file.

1. Open a new terminal in the project folder you created with `npx canary-lab init`.
2. Run `claude` (or `codex`) there.
3. Send the single prompt: `self heal`.

The interactive agent reads the managed `heal-prompt` section in `CLAUDE.md` (or `AGENTS.md`) and writes the same `.restart` / `.rerun` signal files described above.

### Why this works for agents

The agent is not asked to reconstruct the run from terminal scrollback. In both flavors, it starts from the active run's `heal-index.md` (a compact index over each failure, pointing at pre-sliced service logs under `failed/<slug>/`) and falls back to `e2e-summary.json` if the index is missing. Canary Lab gives it:

- `logs/current/heal-index.md` as the first stop when failures have been enriched
- failure-specific files under `logs/current/failed/<slug>/` instead of whole-service scrollback
- `logs/current/e2e-summary.json` and `logs/current/playwright-events.jsonl` for the current Playwright state
- `logs/current/diagnosis-journal.md` when prior heal cycles exist
- `logs/current/signals/.rerun` and `logs/current/signals/.restart` so the runner owns the next Playwright pass and service restart

## Limitations

- The self-fixing workflow depends on services writing useful log output. If a service produces little or no logs, the agent has less context to work with.
- Envset runs overwrite target files in place while the run is active. If the backup/restore cycle is interrupted (e.g., kill -9), originals may not be restored automatically. Re-open the UI and use the envset controls to recover from backups.
- Envset files are local dev config. They are not validated or checked for correctness — if you copy a stale config, tests may fail for non-obvious reasons.

## How It Works

### Runtime flow

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontFamily": "Inter, ui-sans-serif, system-ui, sans-serif", "primaryTextColor": "#0f172a", "lineColor": "#64748b"}}}%%
flowchart TD
    A["Start a run from the web UI"] --> B["Start services in node-pty panes"]
    B --> C["Wait for health checks"]
    C --> D["Run Playwright"]
    D --> E["Write per-run logs, events, artifacts, and summary"]
    E --> F["Render run detail in the UI"]
    F --> G{"Failure?"}
    G -->|No| H["Keep run history for review"]
    G -->|Yes| I["Manual or auto-heal agent reads failure context"]
    I --> J["Agent fixes implementation"]
    J --> K["Agent signals .restart or .rerun"]
    K --> D

    classDef entry fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e,stroke-width:2px
    classDef service fill:#f0fdf4,stroke:#16a34a,color:#14532d,stroke-width:2px
    classDef test fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px
    classDef artifact fill:#f3e8ff,stroke:#9333ea,color:#581c87,stroke-width:2px
    classDef heal fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px
    classDef done fill:#f8fafc,stroke:#64748b,color:#334155,stroke-width:2px

    class A entry
    class B,C service
    class D test
    class E,F artifact
    class G,H done
    class I,J,K heal
```

## For Contributors

### Code Orientation

- `server.ts` wires the local Fastify app, UI assets, routes, and WebSocket streams.
- `orchestrator.ts` is the conductor for a run: service startup, health checks, Playwright invocation, run manifest updates, envset cleanup, and heal-loop signaling.
- `run-store.ts` indexes per-run manifests, summaries, Playwright events, and retained artifacts for the UI.
- `env-switcher/switch.ts` still performs the low-level env-file apply/revert work; the UI is the public way to drive it.
- `feature-support/` is the public import surface generated projects use (`canary-lab/feature-support/...`). Everything under `apps/`, `scripts/`, and `shared/` is internal.

### Run Architecture

This diagram shows the code path for a run started from `canary-lab ui`. It is intentionally implementation-facing; the UI still presents this as one run detail view.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontFamily": "Inter, ui-sans-serif, system-ui, sans-serif", "primaryTextColor": "#0f172a", "lineColor": "#64748b", "clusterBkg": "#ffffff", "clusterBorder": "#cbd5e1"}}}%%
flowchart TD
    user(["Run button in canary-lab ui"])
    web["Web server + run store<br/>server.ts + run-store.ts"]
    runtime["Run orchestrator<br/>orchestrator.ts + run-paths.ts"]
    setup["Env + service startup<br/>env-switcher/switch.ts + pty-spawner.ts + launcher/startup.ts"]
    playwright(["Playwright"])
    capture["Run capture<br/>log-marker-fixture.ts + summary-reporter.ts"]
    autoheal["Auto-heal command builder<br/>auto-heal.ts"]
    agent(["Claude Code or Codex CLI"])

    subgraph runDir["logs/runs/{{runId}}/"]
        state[/"manifest.json + runner.log"/]
        logs[/"svc-*.log + playwright.log"/]
        evidence[/"playwright-events.jsonl + playwright-artifacts/ + e2e-summary.json"/]
        healctx[/"failed/{{slug}}/ + heal-index.md + diagnosis-journal.md"/]
        transcript[/"agent-transcript.log"/]
        signals[/"signals/.heal + .rerun + .restart"/]
    end

    user --> web --> runtime --> setup --> playwright
    runtime --> state
    setup --> logs
    playwright --> logs
    playwright --> capture
    capture --> evidence
    capture --> healctx
    evidence --> autoheal
    healctx -.-> autoheal
    autoheal --> agent
    agent --> transcript
    agent -.-> healctx
    agent --> signals
    signals --> runtime

    classDef entry fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e,stroke-width:2px
    classDef core fill:#eef2ff,stroke:#4f46e5,color:#312e81,stroke-width:2px
    classDef runtime fill:#f0fdf4,stroke:#16a34a,color:#14532d,stroke-width:2px
    classDef test fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px
    classDef heal fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px
    classDef artifact fill:#f8fafc,stroke:#64748b,color:#334155,stroke-width:1.5px

    class user entry
    class web core
    class runtime,setup runtime
    class playwright,capture test
    class autoheal,agent heal
    class state,logs,evidence,healctx,transcript,signals artifact
```

### Local Development

```bash
npm install
npm run build
```

### Repository Layout

- `scripts/` — CLI entry and scaffold/upgrade commands
- `apps/web-server/` — local server, API routes, runtime orchestrator, run store, and PTY streams
- `apps/web/` — React UI for features, runs, playback, journals, and configuration
- `shared/e2e-runner/` — Playwright fixture support used by generated projects
- `shared/configs/` — base Playwright config and env loader
- `shared/runtime/` — shared `project-root` resolver
- `templates/project/` — files copied into scaffolded projects

The package exposes a `canary-lab/feature-support/...` import surface to generated projects via the `exports` field in `package.json`; it maps to compiled files under `dist/shared/configs/`.

### Build and Test

```bash
npm run build
npm test              # unit tests (Vitest)
npm run smoke:pack    # end-to-end scaffold test
```

`npm test` runs the Vitest unit suite. Use `npm run test:watch` during development and `npm run test:coverage` for a coverage report.

`smoke:pack` builds, packs, scaffolds a temp project, installs dependencies, and verifies the scaffold flow. Run it after changing templates or packaging.

### Contributing

Open a pull request against `main`.

## License

[MIT](LICENSE)
