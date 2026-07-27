---
name: cl_verify-changes
description: Use before claiming any canary-lab change works, when deciding which checks a change needs, or when tests/coverage behave strangely (coverage .tmp ENOENT, template edits not showing up, UI server running stale code).
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

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
- **Don't reach for a `/* v8 ignore */` pragma** — write a real test, delete the
  arm, or make the state unrepresentable in the type. The one permitted exception
  and how it's policed live in `cl_code-conventions`.
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
`docs/PRD.md` (intent) are single-source per topic, and `.codex/skills/` must match
what's actually on disk.

**The mechanical half is now a gate.** `npm run check:docs` fails on any backticked
repo path, relative link, or `#anchor` in `README.md` / `docs/**` that doesn't
resolve. It runs in CI. Don't hand-check what it checks.

**The judgement half is still yours**, because the gate can't tell TRUE from
merely well-spelled — a doc naming only live files can still describe last
release's behaviour. Run it when your change alters something a doc *describes*.
The four drift classes that have actually bitten, each with its probe:

| Class | Smells like | Probe |
| --- | --- | --- |
| **Enumeration** — a doc lists what the code lists | profiles, CLI subcommands, feature dirs, tool arrays, sample features | diff the prose against the source of truth: `mcp/tool-profiles.ts`, `apps/cli/cli.ts`'s switch, `ls apps/*/src/features` |
| **Quoted constant** — a doc states a number | timeouts, staleness windows, thresholds, ports, file counts | grep the constant, don't trust the prose: `grep -rn 'HEARTBEAT_STALE_MS\|DEFAULT_.*=' shared/ apps/` |
| **Deleted or moved surface** — a doc names UI that no longer exists | "the X wizard", "the Y pill", a route, a tab label | grep the label in `apps/web/src`; zero hits on a doc's UI noun is a finding |
| **Flipped default** — a doc says the user is asked, and they aren't | autopilot, default profile, opt-in that became opt-out | find the default in code AND confirm with a test, not just the constant |

A hardcoded path list in a doc is a finding even when every path resolves — the
shipped skill set moves (the run loop already migrated from `canary-lab/` to
`canary-lab-run/`). Prefer a discovery command in the prose over an enumeration:

```bash
diff <(ls .codex/skills) <(grep -o 'cl_[a-z-]*' CLAUDE.md | sort -u)   # index vs disk
find agent-integrations -name SKILL.md | wc -l                          # what a list would have to say
```

> The 1.6.0 audit found 26 findings against these docs, and the discipline-only
> version of this section caught none of them. If your change makes a doc
> sentence false, fixing the doc is part of the change — not a follow-up.

## Common mistakes

| Mistake | Reality |
| --- | --- |
| Running the full suite and reading exit 143 as green | Wall-clock kill, not a pass — scope the run and re-check |
| Running `canary-apply` when `cl_apply-local` is absent | That's the shipped rule — the user controls the cycle; hand off |
| Handing off when `cl_apply-local` IS present | You're stalling on work this machine authorized you to do |
| Verifying a template or prompt edit with unit tests only | Consumers get `dist/`; only `smoke:pack` proves the copy |
| Adding a v8 ignore pragma to make coverage pass | Almost always wrong — delete the arm or write the test. The one exception (an unreachable defence-in-depth guard) needs a `-- reason` AND a `check:conventions` allowlist entry; see `cl_code-conventions` |
| Retrying flaky coverage as-is | Known `.tmp` race — use `--no-file-parallelism` |
