# Contributing to Canary Lab

**Quickstart** — branch off `main` → code → `npm run build && npm test && npm run smoke:pack` → PR back into `main`.

> Usage: [README](../README.md) · Internals: [ARCHITECTURE.md](ARCHITECTURE.md)

## Code Orientation

Both apps are organized **by feature, not by layer**. `apps/web-server/src/features/`
and `apps/web/src/features/` share one taxonomy — `runs`, `agent-sessions`,
`coverage`, `wizard`, `evaluation`, `config`, `portify`, `benchmark` (web also has
UI-only `logs`) — so a feature traces client↔server. Cross-feature infra lives in
each app's `src/shared/`.

| Entry point | What it does |
|---|---|
| `apps/web-server/server.ts` | Fastify app, UI assets, routes, WebSocket streams |
| `…/runs/logic/runtime/orchestrator.ts` | services, health checks, Playwright runs, heal signals |
| `…/runs/logic/run-store.ts` | per-run manifests, summaries, events, artifacts |
| `…/runs/logic/runtime/env-switcher/switch.ts` | env-file apply/revert |
| `feature-support/` | public import surface for generated projects |

Everything under `apps/`, `scripts/`, `shared/` is **internal** unless exposed via
`canary-lab/feature-support/...`. Full map: [ARCHITECTURE.md → Module Map](ARCHITECTURE.md#module-map).
Run path + diagram: [ARCHITECTURE.md → Run Lifecycle](ARCHITECTURE.md#run-lifecycle).

## Build and Test

```bash
npm install
npm run build          # required first
npm test
npm run smoke:pack     # after any template/packaging change
```

| Command | When |
|---|---|
| `npm run test:watch` | active development |
| `npm run test:coverage` | coverage report |
| `npx tsc -p tsconfig.build.json --noEmit` | typecheck |
| `npm run smoke:pack` | packs, scaffolds, installs, verifies scaffold flow |

## Pull Requests

Branch off `main` → PR back into `main`.
