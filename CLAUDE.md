# Canary Lab — Contributor Notes

Canary Lab is one published CLI (`canary-lab`): the AI repair loop for Playwright.
Internals ship compiled in `dist/`; scaffold templates in `templates/project/` are
copied to `dist/templates/` during build.

## Commands

- Build: `npm run build`
- Test: `npx vitest run` (co-located `*.test.ts`; component tests use happy-dom)
- Typecheck: `npx tsc -p tsconfig.build.json --noEmit`
- Tarball smoke test: `npm run smoke:pack`
- Coverage: `npm run test:coverage` — known `coverage/.tmp` race; recover with
  `rm -rf coverage && npx vitest run --coverage --no-file-parallelism`
- Publish: `npm run publish:package` (use the `cl_release` skill)

## Hard rules

- **Never run the canary-apply rebuild/restart cycle** — the user runs it themselves
  (see the `cl_verify-changes` skill for the hand-off).
- **Never add `/* v8 ignore */` pragmas** — write a real test or use a config-level
  exclude.
- Touching `apps/web-server/mcp/tools.ts` or any run-loop semantics (collision,
  queue, boot sessions, heal claims, pass counts) → use the `cl_add-mcp-tool` /
  `cl_sync-agent-surfaces` skills. The sync invariants are easy to miss by hand.
- Changes under `templates/` only ship via the build — finish with
  `npm run smoke:pack` (see the `cl_add-sample-feature` skill).

## Where things are documented

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map, run lifecycle,
  concurrency, heal system, MCP layer, and the canonical keep-in-sync invariants
  table.
- [docs/PRD.md](docs/PRD.md) — product intent, non-goals, and quality bars
  (reverse-engineered; the tie-breaker for product-questionable changes).
- `.claude/skills/cl_*` — contributor workflows (MCP tools, agent-surface sync,
  verification ladder, sample features, release).
- [docs/GUIDE.md](docs/GUIDE.md) / [docs/FEATURES.md](docs/FEATURES.md) /
  [docs/COMMANDS.md](docs/COMMANDS.md) — user-facing docs (env switching incl.
  remote-URL testing, run output, CLI reference).
