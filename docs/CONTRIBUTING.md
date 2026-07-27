# Contributing to Canary Lab

**Quickstart** — branch off `main` → code → `npm run build && npm test && npm run smoke:pack` → PR back into `main`.

> Usage: [README](../README.md) · Internals: [ARCHITECTURE.md](ARCHITECTURE.md)

## Code Orientation

Both apps are organized **by feature, not by layer**. `apps/web-server/src/features/`
and `apps/web/src/features/` share an eight-feature spine — `runs`, `coverage`,
`flights`, `wizard`, `evaluation`, `config`, `portify`, `benchmark` — so a feature
traces client↔server. Three features live on one side only: `agent-sessions` and
`version` are server-only, `cleanup` is web-only (its `/api/cleanup/*` routes are owned
by `runs` and `portify`). Cross-feature infra lives in each app's `src/shared/`.

| Entry point | What it does |
|---|---|
| `apps/web-server/src/server.ts` | Fastify app, UI assets, routes, WebSocket streams |
| `…/runs/logic/runtime/orchestrator.ts` | services, health checks, Playwright runs, heal signals |
| `…/runs/logic/run-store.ts` | per-run manifests, summaries, events, artifacts |
| `…/runs/logic/runtime/env-switcher/switch.ts` | env-file apply/revert |
| `canary-lab/feature-support/*` | public import surface for generated projects — an exports map in `package.json`, not a directory; it points into `dist/shared/` |

Everything under `apps/` and `shared/` is **internal** unless exposed via
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
| `npm run check:conventions` | the mechanical half of the code conventions (incl. the `v8 ignore` allowlist) |
| `npm run check:boundaries` | web feature barrels — no deep cross-feature imports, no stale `ALLOWED_DEEP` entry |
| `npm run check:docs` | contributor docs — every backticked repo path, link and `#anchor` resolves |
| `npm run smoke:pack` | packs, scaffolds, installs, verifies scaffold flow |

Run all three `check:*` gates before opening a PR; they catch what tests don't.
`check:docs` only proves references resolve, never that the prose is still true —
the judgement half of the docs audit lives in the `cl_verify-changes` skill.

## Pull Requests

Branch off `main` → PR back into `main`.
