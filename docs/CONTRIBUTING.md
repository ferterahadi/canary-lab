# Contributing to Canary Lab

Thanks for working on Canary Lab. This guide covers the repository layout, local
development, and the build and test workflow. For user-facing usage, see the
[README](../README.md). For deeper internal notes, see [AGENTS.md](../AGENTS.md).

## Code Orientation

- `server.ts`: local Fastify app, UI assets, routes, and WebSocket streams
- `orchestrator.ts`: service startup, health checks, Playwright runs, manifests, envset cleanup, and heal-loop signals
- `run-store.ts`: per-run manifests, summaries, Playwright events, and artifacts for the UI
- `env-switcher/switch.ts`: low-level env-file apply and revert logic
- `feature-support/`: public import surface for generated projects

Everything under `apps/`, `scripts/`, and `shared/` is internal unless exposed through `canary-lab/feature-support/...`.

## Run Architecture

This diagram shows the code path for a run started from `canary-lab ui`.

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
    agent(["AI Agent"])

    subgraph runDir["logs/runs/{{runId}}/"]
        state[/"manifest.json + runner.log"/]
        logs[/"svc-*.log + playwright.log"/]
        evidence[/"playwright-events.jsonl + playwright-artifacts/ + e2e-summary.json"/]
        healctx[/"failed/{{slug}}/ + heal-index.md + diagnosis-journal.md"/]
        session[/"agent-session.json + agent-session-id.txt"/]
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
    agent --> session
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
    class state,logs,evidence,healctx,session,signals artifact
```

## Local Development

```bash
npm install
npm run build
```

## Repository Layout

- `scripts/`: CLI entry, scaffold/setup/upgrade commands, and MCP bridge
- `apps/web-server/`: local server, API routes, runtime orchestrator, run store, and PTY streams
- `apps/web/`: React UI
- `shared/e2e-runner/`: Playwright fixture support
- `shared/configs/`: base Playwright config and env loader
- `shared/runtime/`: shared project-root resolver
- `templates/project/`: scaffolded project files

The package exposes `canary-lab/feature-support/...` through `package.json` exports.

## Build and Test

```bash
npm run build
npm test
npm run smoke:pack
```

Use `npm run test:watch` during development and `npm run test:coverage` for coverage.
Typecheck with `npx tsc -p tsconfig.build.json --noEmit`.

`smoke:pack` builds, packs, scaffolds a temporary project, installs dependencies, and verifies the scaffold flow. Run it after changing templates or packaging.

## Pull Requests

Open a pull request against `main`.
