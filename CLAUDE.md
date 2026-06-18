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
- [docs/GUIDE.md](docs/GUIDE.md) / [docs/FEATURES.md](docs/FEATURES.md) /
  [docs/COMMANDS.md](docs/COMMANDS.md) — user-facing docs (env switching incl.
  remote-URL testing, run output, CLI reference).

## Skills — `.claude/skills/cl_*` (read before you touch the matching area)

These encode the project's conventions and taste. Whenever a task matches one,
invoke the skill **before** acting — they hold invariants and design rules that
are easy to miss by hand. (Claude: via the Skill tool. Codex: skills load
natively.)

**Process / how to work**
- `cl_scope-the-ask` — vague "improve/fix/polish X" request: look at the target
  first, ask one open question; never fire an options menu guessing the goal.
- `cl_verify-changes` — which checks a change needs before claiming it works;
  the canary-apply hand-off; coverage/template/stale-server gotchas.
- `cl_release` — publishing the package (`npm run publish:package`).

**Run loop & MCP layer**
- `cl_add-mcp-tool` — add/remove/rename/move a tool in
  `apps/web-server/mcp/tools.ts`, or fix tool-count / unknown-tool smoke fails.
- `cl_sync-agent-surfaces` — after changing run-loop semantics (collision,
  queue, boot sessions, heal claims, signal/rerun, pass counts): keep MCP
  instructions, tool results, and shipped `SKILL.md` files in agreement.
- `cl_add-sample-feature` — editing sample features under `templates/project/`
  (feature.config.cjs, envsets, e2e specs); template changes ship via build.
- `cl_async-task-ux` — adding a long-running background task (coverage,
  portify, gen): the non-blocking · persistent · recoverable · re-openable ·
  single-flight contract and the file-backed store pattern.

**Web UI (`apps/web`) — design language & live behavior**
- `cl_ui-design-philosophy` — building/restyling any panel, dialog, pill, card,
  or full-screen view: reuse the token system and layout precedents; no new
  component library; meaning carries the style.
- `cl_design-feedback` — critiquing a UI (screenshot, live screen, Figma,
  component): ground every finding in the component source + tokens before
  voicing it; don't flag a shared primitive or intentional choice as a defect.
- `cl_live-state-sync` — a UI that must react in real time to a backend state
  change, or anything that "only updates after refresh": picking
  broadcast-push vs task-scoped stream vs refetch.
- `cl_surfacing-agent-work` — any UI showing an agent's progress/output (live
  or historical): know what the agent actually produces before designing the
  viewer.
