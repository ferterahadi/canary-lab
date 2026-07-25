---
name: cl_verify-changes
description: Use before claiming any canary-lab change works, when deciding which checks a change needs, or when tests/coverage behave strangely (coverage .tmp ENOENT, template edits not showing up, UI server running stale code).
---

# Verifying Canary Lab Changes

Pick the lowest tier that actually exercises the change, then run every tier at or
below it. "Tests pass" at the wrong tier proves nothing — template and server changes
have failure modes unit tests can't see.

## The ladder

### Tier 1 — always: unit tests + typecheck

```bash
npx vitest run <paths touched by the change>
npx tsc -p tsconfig.build.json --noEmit
```

- **Scope the run to what you changed.** The full suite is ~275 files; a bare
  `npx vitest run` is for release (`cl_release`), not for an iteration. Run the
  affected files plus anything that greps for the symbol you touched.
- **A killed run is not a green run.** The full suite is known to get
  SIGTERM'd on the wall clock (exit **143/144**) while reporting 0 failures.
  Exit 143/144 = *inconclusive*; re-run scoped before claiming anything passes.
- Tests are co-located `*.test.ts`; component tests use happy-dom.
- **Never add `/* v8 ignore */` pragmas** — write a real test or use a config-level
  exclude.
- Coverage (`npm run test:coverage`) has a known race: intermittent ENOENT on
  `coverage/.tmp`. Recover with `rm -rf coverage && npx vitest run --coverage --no-file-parallelism`.

### Tier 2 — templates, packaging, exports: smoke the tarball

Changes under `templates/`, `apps/web-server/prompts/`, `tools/*.mjs`, or
`package.json` exports only reach consumers through the build
(`templates/project/` → `dist/templates/`). Run:

```bash
npm run smoke:pack
```

### Tier 3 — live confirmation of `apps/web-server/**` or `apps/web/**`

Source edits only take effect in a real workspace after the rebuild + reinstall +
server-restart cycle (`canary-apply`).

**Default (shipped rule): don't run the cycle yourself — the user runs it.** Stop and
ask the user to run `canary-apply` and restart the UI.

**Exception — check for `cl_apply-local` first.** If that skill exists in this
checkout, this machine has opted into running the cycle yourself: invoke it and
verify end-to-end instead of handing off. It's gitignored, so its presence *is* the
signal; absent → hand off as above. For an `apps/web`-only visual check you can skip
both and use the Vite dev server (`canary-web-dev`) for HMR.

Either way, confirm the server picked up the change before claiming it works: derive
the port (never hardcode 7421 — see `cl_apply-local`), hit `GET /mcp/health`, then
exercise the changed surface.

### Tier 4 — heal-loop semantics

Changes to the external run loop (claim, wait, signal, collision, boot sessions) need
an end-to-end pass: drive the MCP loop against the `broken_todo_api` sample
(`start_run` with `claim_heal` → `wait_for_heal_task` → fix → `signal_run` → wait).
The old `tools/verify-external-heal.sh` REST smoke was removed — the MCP loop is the
current path. Evidence-integrity expectations for that loop (honest counts, the
repair rule, artifact retention) live in `cl_run-evidence-invariants`.

## Quick reference

| Change touches | Run tiers |
| --- | --- |
| `shared/`, `apps/web-server/src/features/**` logic | 1 |
| `templates/`, `apps/web-server/prompts/`, `tools/`, packaging | 1 + 2 |
| `apps/web-server/**` / `apps/web/**` needing live proof | 1 (+2 if templates/prompts) + 3 |
| MCP run-loop semantics | 1 + 3 + 4, plus `cl_sync-agent-surfaces` |
| Run evidence: counts, artifacts, export status | 1 + 4, plus `cl_run-evidence-invariants` |

## Contributor-docs audit

`CLAUDE.md` (commands + rules), `docs/ARCHITECTURE.md` (mechanisms), and
`docs/PRD.md` (intent) are single-source per topic, and `.claude/skills/` must match
what's actually on disk. Nothing enforces it automatically — run this when you add,
rename, or delete a skill, or when a doc names a file list:

```bash
diff <(ls .claude/skills) <(grep -o 'cl_[a-z-]*' CLAUDE.md | sort -u)   # index vs disk
grep -rn 'agent-integrations/[a-z]*/skills/[a-z-]*/SKILL.md' docs/ .claude/skills/  # hardcoded file lists
find agent-integrations -name SKILL.md | wc -l                          # what the list should be
```

A hardcoded path list in a doc is a finding — the shipped skill set moves (the run
loop already migrated from `canary-lab/` to `canary-lab-run/`). Prefer a discovery
command in the prose over an enumeration.

## Common mistakes

| Mistake | Reality |
| --- | --- |
| Running the full suite and reading exit 143 as green | Wall-clock kill, not a pass — scope the run and re-check |
| Running `canary-apply` when `cl_apply-local` is absent | That's the shipped rule — the user controls the cycle; hand off |
| Handing off when `cl_apply-local` IS present | You're stalling on work this machine authorized you to do |
| Verifying a template or prompt edit with unit tests only | Consumers get `dist/`; only `smoke:pack` proves the copy |
| Adding v8 ignore pragmas to make coverage pass | Forbidden in this repo; write the test |
| Retrying flaky coverage as-is | Known `.tmp` race — use `--no-file-parallelism` |
