# Contributing to Canary Lab

**Quick start:** branch from `main`, make the change, run relevant checks, and open a pull request to `main`.

> Usage: [README](../README.md) · Internals: [ARCHITECTURE.md](ARCHITECTURE.md)

## Code Orientation

Both apps are organized **by feature, not technical layer**. The server and web app share eight feature names: `runs`, `coverage`, `flights`, `wizard`, `evaluation`, `config`, `portify`, and `benchmark`, making each area easy to trace across client and server.

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
| `npm run smoke:demo` | LLM-free gate for the five-journey repair cascade; removes its temporary workspace |
| `npm run demo -- --agent codex` | creates an inspectable demo workspace with repair-loop and full-Flight routes |

### Test the demo from a desktop agent

`npm run demo` does not change your Model Context Protocol (MCP) client configuration. To use Getting Started from Codex Desktop or Claude Desktop:

1. Run `npm run demo -- --agent codex`, leave that terminal running, and copy the **Workspace** path it prints.
2. In another terminal, connect both supported agents from that generated workspace:

   ```bash
   cd "<workspace path>"
   npx canary-lab setup --force --agent all
   ```

3. Restart the desktop app. Open a fresh session **in the generated workspace**. Otherwise, Getting Started resolves sample folders from the wrong directory.
4. Confirm `Canary_Lab` appears in the session's MCP tools. Open **Getting Started** in Canary Lab and paste the selected **In your agent** command into the session.

Keep the demo terminal running. Each demo creates a new workspace, so repeat setup for each one. For a custom MCP client, copy the endpoint from Canary Lab's **MCP** status.

Before opening a PR, run `check:conventions`, `check:boundaries`, `check:docs`, `check:wire`, and `check:cycles`. They catch structural drift missed by tests and TypeScript.

`check:docs` proves that paths, links, and anchors resolve. It does not prove the wording is still true; compare factual claims with the current code during review.
