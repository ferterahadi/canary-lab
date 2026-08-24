# Contributing to Canary Lab

Canary Lab is one published CLI with a local Fastify server, a React web app,
and scaffolded Playwright projects. Start changes from `main`, keep them inside
the owning feature, run the checks that exercise the changed surface, and open a
pull request to `main`.

> Product intent: [PRD](PRD.md) · Internals: [Architecture](ARCHITECTURE.md) · Usage: [Guide](GUIDE.md)

## Prerequisites

- Node.js 22.12 or newer
- npm 9 or newer

Install dependencies once:

```bash
npm install
```

## Find the owner before editing

The server and web app are organized by product feature, not by technical
layer. They share eight feature names: `runs`, `coverage`, `flights`, `wizard`,
`evaluation`, `config`, `portify`, and `benchmark`.

- `agent-sessions` and `version` are server-only features.
- `cleanup` is web-only. Its server routes stay with the `runs` and `portify`
  stores that own the deleted data.
- Cross-feature infrastructure belongs in the relevant `src/shared/` folder.

| Entry point | Responsibility |
| --- | --- |
| `apps/cli/cli.ts` | CLI command dispatch |
| `apps/web-server/src/server.ts` | Server composition, shared stores, and feature registration |
| `apps/web-server/src/features/runs/logic/runtime/orchestrator.ts` | Service boot, Playwright execution, repair cycles, and teardown |
| `apps/web-server/src/features/runs/logic/run-store.ts` | Run manifests, summaries, events, and artifacts |
| `apps/web-server/src/features/runs/logic/runtime/env-switcher/switch.ts` | Envset apply and restore |
| `apps/web/src/features/` | React feature modules and their public barrels |
| `shared/` | Code shared by the CLI, server, generated projects, or web app |
| `templates/project/` | Files copied into newly initialized workspaces |

Everything under `apps/` and `shared/` is internal unless `package.json`
exports it under `canary-lab/feature-support/...`. See the
[module map](ARCHITECTURE.md#module-map) and
[run lifecycle](ARCHITECTURE.md#run-lifecycle) before changing ownership or
runtime flow.

## Work in the existing design

- Server features register routes and return only the handles another feature
  genuinely needs. They are not re-export barrels.
- Web features expose their cross-feature API through `index.ts`. Do not deep
  import another feature's implementation.
- Put LLM prompts in `apps/web-server/prompts/` and load them through the shared
  prompt loader. Do not inline prompts in TypeScript.
- Change generated workspace behavior in `templates/project/`, then verify the
  packed artifact. A source-only test does not prove the template shipped.
- Preserve the repair rule: fix application or service code. Do not weaken a
  test to make a run pass.

The repository-specific skills under `.codex/skills/` and `.claude/skills/`
contain procedures for high-risk areas. `CLAUDE.md` is the canonical index of
when to use them.

## Build and test

Start with the narrowest check that exercises your change. A full build is not
a prerequisite for every unit-test iteration.

| Command | Use it for |
| --- | --- |
| `npx vitest run <paths>` | Tests closest to the changed code |
| `npm run typecheck:all` | CLI, server, and web TypeScript contracts |
| `npm run build` | Complete distributable build, including generated docs, skills, templates, and web assets |
| `npm run test:watch` | Local test-driven development |
| `npm run test:coverage` | Coverage report |
| `npm run check:conventions` | Repository rules that lint and TypeScript do not express |
| `npm run check:boundaries` | Web feature barrels and cross-feature imports |
| `npm run check:docs` | Backticked paths, relative links, and Markdown anchors |
| `npm run check:wire` | Server responses and their hand-written web mirrors |
| `npm run check:cycles` | Import-cycle ceilings |
| `npm run smoke:pack` | Packed install, scaffold, exports, templates, or prompts |
| `npm run smoke:demo` | LLM-free storefront repair cascade |
| `npm run demo -- --agent codex` | Inspectable demo workspace and full Flight routes |
| `npm run demo:clean` | Remove stopped, unregistered workspaces under `~/Canary Lab Demos/` |

Before opening a pull request, always run the structural gates:

```bash
npm run check:conventions
npm run check:boundaries
npm run check:docs
npm run check:wire
npm run check:cycles
```

Also run scoped tests and the relevant typecheck. Add `npm run smoke:pack` when
the change touches `templates/`, prompts, packaging, build tools, or exports.

`check:docs` proves that paths, links, and anchors resolve. It cannot prove that
the prose describes current behavior. Compare enumerations, defaults, constants,
and lifecycle claims with the implementation during review.

## Test the demo from a desktop agent

`npm run demo` starts a retained workspace in the current user's
`Canary Lab Demos` folder (`~/Canary Lab Demos/` on macOS/Linux and
`%USERPROFILE%\Canary Lab Demos\` on Windows), but does not rewrite a Model
Context Protocol (MCP) client's configuration.

1. Run `npm run demo -- --agent codex`, keep the terminal open, and copy the
   printed **Workspace** path.
2. From another terminal, register both supported agent clients in that
   generated workspace:

   ```bash
   cd "<workspace path>"
   npx canary-lab setup --force --agent all
   ```

3. Restart the desktop app and open a new session. The session does not have to
   be rooted in the generated workspace: the demo server records itself in
   `~/.canary-lab/active-servers.json` like any other, and step 2 pins that
   workspace on the Claude Desktop entry, so a client resolves it from anywhere.
4. Confirm the `Canary_Lab` `exec` tool appears in the session's MCP tools. In Canary Lab, open
   **Getting Started** and paste its **In your agent** command into the session.

Keep the demo terminal running. Each demo command creates a new workspace, so
repeat registration when the workspace changes. Custom MCP clients can use the
endpoint shown by Canary Lab's **MCP** status.

On exit the demo removes its own entries from `~/.canary-lab`. It does not move
your MCP client registrations back — step 2 pointed them at the demo, and
`npx canary-lab ui` from a durable workspace re-points them on its next boot.
