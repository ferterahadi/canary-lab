# Contributing to Canary Lab

**Quick start:** branch from `main`, make the change, run the checks that exercise it, then open a pull request back to `main`.

> Usage: [README](../README.md) · Internals: [ARCHITECTURE.md](ARCHITECTURE.md)

## Code Orientation

Both apps are organized **by feature, not by technical layer**. The server and web app share eight feature names: `runs`, `coverage`, `flights`, `wizard`, `evaluation`, `config`, `portify`, and `benchmark`. This makes one product area easy to trace across the client and server.

`agent-sessions` and `version` exist only on the server. `cleanup` exists only in the web app; its routes remain with the `runs` and `portify` stores that own the data. Shared infrastructure belongs in each app's `src/shared/` folder.

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
| `npm run check:wire` | server responses and their hand-written web mirrors stay aligned |
| `npm run check:cycles` | import cycles stay within the recorded ceilings |
| `npm run smoke:pack` | packs, scaffolds, installs, verifies scaffold flow |
| `npm run smoke:demo` | LLM-free gate for the canonical five-journey repair cascade (ten cycles across three services); exits and removes its throwaway workspace |
| `npm run demo -- --agent codex` | provisions the one demo workspace with the storefront suite installed, offers the repair-loop and full-Flight routes, leaves both under tester control, and keeps the workspace for inspection |

Run all five repository gates before opening a PR: `check:conventions`, `check:boundaries`, `check:docs`, `check:wire`, and `check:cycles`. They catch structural drift that tests and TypeScript cannot.

`check:docs` proves that paths, links, and anchors resolve. It does not prove the wording is still true; compare factual claims with the current code during review.

## Pull Requests

Branch off `main` → PR back into `main`.
