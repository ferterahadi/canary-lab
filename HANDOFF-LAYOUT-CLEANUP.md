# Handoff — Layout Cleanup

**Scope:** repository layout and module ownership. **No behavior changes.**
Every item below is a move, a rename, a generator, or a declaration.

**Status:** Phases 0–6 are **done and committed**. Phases 7–9 remain. One
non-layout item (a public-repo privacy exposure) is **blocked on a permission**
and needs the owner, not an agent.

**Branch:** `release/1.6.0`. Work in the **main checkout** at
`/Users/oddle/Documents/canary-lab`, never in `.claude/worktrees/*` — three stale
worktrees exist there and are behind.

---

## What already landed (2026-07-26)

| Commit | Phase | Result |
| --- | --- | --- |
| `2140974` | 1 | `tools/gen-codex-skills.mjs` mirrors `.claude/skills` → `.codex/skills` (19 files, `cl_apply-local` excluded); `.agents/` + `yarn.lock` removed; `History` untracked |
| `4421b81` | 2 | 406 boundary-crossing imports in `apps/web` → `@/…` / `@shared/…`; zero 3+-level relative imports remain |
| `02ddf2a` | 3 | web feature `logs` → `cleanup`; `shared/README.md` marks the 4 published paths |
| `f8438d8` | 4 | `server.ts` + `mcp/` moved under `src/`; `tools.ts` 2,740 ln split into `tool-support.ts` + 4 `tool-groups/` |
| `459fb0f` | 5 | `scripts/` → `apps/cli/`; `bin` → `dist/apps/cli/cli.js` |
| `d14ad04`, `a0107e7` | — | fallout fix: a stale MCP registration is now reported instead of failing silently |
| `a4bb2f0`, `298378a` | 6 | all 10 server features expose `register(app, ctx)`; `server.ts` 1,523 → 447 ln |

`origin/release/1.6.0` is at `a4bb2f0`; **`298378a` is unpushed.**

### Current numbers (measured at `298378a`)

| Metric | Value |
| --- | --- |
| Coverage gate | 100/100/100/100 — **162 files**, 12,111 stmts / 8,136 branches / 2,280 funcs / 10,464 lines |
| Tests | 288 files, 5,525 passing, 1 skipped |
| `tsc -p tsconfig.build.json` | clean |
| `typecheck:web` / `:server` | 5 / 17 pre-existing errors, **all in `*.test.ts(x)`** (the build config excludes tests) — this is the baseline, not a regression |
| `server.ts` | 447 ln, 58 imports, 15 dep constructions, 10 register calls |
| `client.ts` | 2,195 ln, 183 exports ← Phase 7 target |
| server `runs` | 15,970 ln ← Phase 8 target |
| Feature barrels | server 10/10 · **web 0/10** ← Phase 9 target |
| Cross-feature imports | web 0 · **server 257** |

---

## Ground rules (non-negotiable)

From `CLAUDE.md` and the `cl_*` skills. Read the named skill before touching the
matching area.

| Rule | Why it matters here |
| --- | --- |
| **Never weaken, skip, or delete a test to make something pass** | Pinned by `apps/web-server/src/mcp/repair-guardrail.test.ts`. A layout refactor has no excuse to touch an assertion. |
| **Never add `/* v8 ignore */` pragmas** | Forbidden repo-wide. If a move drops coverage, fix the config glob, not the gate. |
| **Never edit the prose telling agents to fix the app, not the test** | `REPAIR_INSTRUCTIONS`, heal `MODE_COPY`, shipped `canary-lab-run` skills. |
| **Don't move `apps/web-server/prompts/`** | `tools/prepare-assets.mjs` hardcodes it → `dist/apps/web-server/prompts`. Prompts are assets, not source. |
| **Don't move `templates/`** | Ships only through the build; template-adjacent changes need `npm run smoke:pack`. |
| **Aliases are bundler-only** | `@/…` and `@shared/…` work in `apps/web` because Vite inlines them. `tsc` does **not** rewrite specifiers and there is no `imports` field, so an alias in server/CLI/`shared` ships to `dist/` as a literal `require("@server/…")` and breaks the installed package. Documented in ARCHITECTURE.md → Package Model. |
| **Live proof** | This checkout has a gitignored `cl_apply-local` skill, so run the rebuild/restart cycle yourself instead of handing it off. |

---

## ⚠️ The trap that bit every single phase

**`__dirname`-relative path walks. `tsc` cannot see them, and they fail only at
runtime — often only inside a packed tarball.**

Moving a file changes its depth, silently breaking every `path.resolve(__dirname,
'..', …)` in it. This produced the worst near-miss of the whole effort: after
Phase 4, `server.ts` resolved the built UI one level short and the server booted
**serving no UI at all**. Typecheck was clean. Only the tests caught it.

Before trusting a green `tsc` after any move:

```bash
grep -rn "resolve(__dirname\|join(__dirname\|import\.meta\.dirname" <moved files>
```

Watch for **source-vs-dist candidate pairs** — `apps/cli/init-project.ts` and
`upgrade.ts` try `../x` then `../../x` to work from both the repo and an
installed package. *Both* entries need the added level, and the second one is the
installed-package path, so getting it wrong breaks consumers only.

Also note: some `from '…'` strings live inside **fixture template literals**
(`apps/cli/migrate.test.ts`, `config/routes/features.test.ts`). They are test data,
not imports. A naive sed corrupts them; resolve each specifier against the
filesystem and skip what doesn't exist.

---

## Phase 7 — Slice `client.ts` (~3 h)

`apps/web/src/shared/api/client.ts` is 2,195 lines with 183 exports, imported by
all 10 web features. Exports already group by domain prefix (`Portify*`,
`Flight*`, `Run*`, `Envset*`, `Coverage*`…). Move each group to
`features/<name>/api/`; keep the shared `apiFetch` wrapper in `shared/api/`.

> **⚠ The single biggest trap in this document.** `vitest.config.ts` coverage
> `include` lists `'apps/web/src/shared/api/**/*.ts'`. `apps/web/src/features/*/api/**`
> is **not** in the include list (verified — the only `features` entry is
> `benchmark/state`). Moving those exports drops 2,195 lines out of the 100% gate
> **while the gate still reports 100%**. You must add
> `'apps/web/src/features/*/api/**/*.ts'` to coverage `include` in the same commit.
>
> Confirm against the **file count and totals**, not the percentage:
> ```bash
> grep '^SF:' coverage/lcov.info | wc -l   # must stay 162 (± files you deliberately added)
> ```
> The percentage cannot detect a shrinking denominator. The totals can.

Aliases already exist here — new imports should be `@/features/<name>/api/…`.

---

## Phase 8 — Split `runs` (~4 h)

Server `runs` is 15,970 lines holding four separable concerns that already live in
separate subdirs:

| Subdir | Lines |
| --- | --- |
| `logic/runtime/` (orchestrator, launcher, scheduler) | 10,328 |
| `routes/` | 1,251 |
| `index.ts` (the Phase 6 registrar) | 897 |
| `logic/heal/` | 862 |
| `logic/dirty-specs/` | 587 |
| `ws/` | 270 |

Splitting also breaks the `runs ⇄ config` cycle, which runs through config types
the store needs.

**Required reading first:** `cl_sync-agent-surfaces` (run-loop semantics),
`cl_run-evidence-invariants` (anything producing a verdict), and `cl_add-mcp-tool`
if tool paths move.

> **⚠ Coverage-gate trap.** Four files inside `runs` are named by **exact path**
> in `vitest.config.ts` coverage `exclude`, each with an audited branch-by-branch
> rationale comment. Re-derive before moving anything:
>
> ```bash
> grep -oE "'apps/web-server/src/features/runs/[^']*'" vitest.config.ts
> ```
>
> As of `298378a` that is `logic/runtime/orchestrator.ts`,
> `logic/runtime/log-enrichment.ts`, `logic/runtime/env-switcher/switch.ts`,
> `logic/playwright-list.ts`. (`logic/heal/` is **not** excluded — fully gated.)
> Move any of them and the exclude goes stale → the file re-enters the gate below
> 100% → **the gate goes red**. Update the paths in the same commit and carry the
> rationale comments across verbatim. Do not "fix" a red gate by deleting an
> exclude, adding a pragma, or relaxing a threshold.

**Phase 6 left you a seam to use.** `runs/index.ts` already returns exactly the
three primitives other features share:

```ts
return { scheduler, attachRunStreams, restartExternalRun }
```

`benchmark` and `coverage` take that handle; the MCP mount uses
`restartExternalRun`. Whatever the split produces must keep that return shape (or
update all three consumers together). `features/runs/logic/runtime/run-primitives.ts`
(`allocateRunPorts`, `applyFeatureEnvset`) is shared by runs, coverage and
benchmark — it must stay reachable from all three.

**Verify:** Tier 1 + Tier 3 + **Tier 4** — drive the MCP heal loop end to end
against the `broken_todo_api` sample (`start_run` with `claim_heal` →
`wait_for_heal_task` → fix → `signal_run` → wait).

---

## Phase 9 — Barrels + boundary lint (~2 h)

**Do this last.** Server features already have barrels (Phase 6 gave all 10 an
`index.ts`), so the remaining work is:

1. **Web barrels — 0 of 10 features expose an `index.ts`.** Give each one a public
   surface.
2. **Boundary lint** forbidding deep sibling imports (`../../<other-feature>/…`) so
   the seam cannot re-erode. Current state: **web 0** such imports (the Phase 2
   alias codemod already routed them through `@/`), **server 257**.
3. **The missing convention doc** in `docs/ARCHITECTURE.md`: which per-feature
   subdirs are required and which are optional. Today the convention is nominal —
   `logic/` is universal, `routes/` is absent from `agent-sessions`, `ws/` exists in
   4 of 10 server features, and web `config` is ~6,000 lines of components with no
   state or api layer. A feature with no realtime surface *should not* have an empty
   `ws/`; the problem is that nothing says so, so nothing can check it.

Note the server barrels are **registrars**, not re-export barrels — `register(app,
ctx)` plus a returned handle. If you add re-exports, don't break that contract.

---

## ⛔ Blocked — needs the owner, not an agent

**`History` is a Chromium browsing-history database** (56 URLs, 74 visits) committed
in `c5f0395` and pushed to **github.com/ferterahadi/canary-lab, which is PUBLIC**.
Phase 1 untracked and gitignored it, which stops future commits but does **not**
remove it from the published history.

An agent attempt to run `git filter-repo` was **denied by the permission
classifier**, correctly — it rewrites published history. Do not try to route around
it with `filter-branch`; that is the same destructive operation.

Everything is staged for whoever runs it:

- Scope confirmed: blob exists only between `c5f0395` and `2140974`, on
  `release/1.6.0` only — **not on `main`**, no tags, **0 forks**, no open PRs
- A full backup bundle of all refs was taken during the session (regenerate with
  `git bundle create <path> --all` before starting)

```bash
git filter-repo --path History --invert-paths --force --refs release/1.6.0
```

Then force-push. Three caveats:

1. `ui-skin-unify` also contains the blob locally — it must not be pushed as-is.
2. A force-push does **not** immediately purge GitHub: unreferenced objects stay
   reachable by SHA until GC. Ask GitHub Support to purge cached views.
3. Treat anything reachable from those 56 URLs as disclosed.

---

## Verification ladder (from `cl_verify-changes`)

| Phase | Tiers |
| --- | --- |
| 7 (slice `client.ts`) | 1 + 3 |
| 8 (split `runs`) | 1 + 3 + 4 |
| 9 (barrels + lint) | 1 + 3 |

- **Tier 1:** `npx vitest run <changed paths>` + `npx tsc -p tsconfig.build.json --noEmit`.
  Scope the run. **Exit 143/144 = inconclusive, not green** — the full suite gets
  SIGTERM'd on the wall clock while reporting 0 failures. Re-run scoped.
- **Tier 2:** `npm run smoke:pack` — the only check that proves `dist/`, `bin`,
  templates, prompts, and exports. It now also runs both generator `--check`s
  *before* the build (after the build they would be tautologies).
- **Tier 3:** invoke `cl_apply-local`. Derive the port from
  `canary-lab.config.json` / `~/.canary-lab/active-servers.json` — **never hardcode
  7421**. After restart, hit one endpoint per feature registrar, not just `/`.
- **Tier 4:** MCP heal loop against `broken_todo_api`.

**Coverage run** (the `.tmp` ENOENT race makes the plain form flaky):

```bash
rm -rf coverage && npx vitest run --coverage --no-file-parallelism
```

**Contributor-docs audit** — run after any phase that renames or moves a path:

```bash
node tools/gen-agents-md.mjs --check && node tools/gen-codex-skills.mjs --check
diff <(ls .claude/skills) <(ls .codex/skills)   # expect only cl_apply-local
grep -rn 'agent-integrations/[a-z]*/skills/[a-z-]*/SKILL.md' docs/ .claude/skills/
```

A hardcoded path list in a doc is a finding — prefer a discovery command in the
prose over an enumeration.

---

## Techniques worth reusing

- **Prune dead imports with the compiler, not a regex.**
  `npx tsc -p tsconfig.build.json --noEmit --noUnusedLocals` names every unused
  specifier and line. This removed 440 of them in Phase 6 with zero false
  positives. `noUnusedLocals` is *not* on in the real config — it is a one-off
  diagnostic.
- **Prove a mechanical move preserved behavior by diffing the bodies**, not by
  reading them. The Phase 4 `tools.ts` split concatenated the extracted group
  bodies and diffed against the original slice — byte-identical, so all 59 tool
  registrations were provably untouched.
- **Re-relativize imports by resolving them**, never by counting `../`. Resolve
  each specifier to a real file from the old location, then recompute from the new
  one; skip anything that doesn't resolve (those are fixture strings).
- **A plan's premises expire.** Three in the original version of this document were
  false by the time they were acted on: aliases could not go repo-wide, `tools.ts`
  could not be split by profile (7 tools belong to several profiles at once), and
  the `--check` there was "already wired next to" had never been called. Verify
  before building.

## Definition of done (Phases 7–9)

- [ ] Coverage 100/100/100/100 **and** the covered-file count still 162 (percentage
      alone does not prove scope was preserved)
- [ ] All three typechecks at baseline (0 / 5 / 17, the latter two test-only)
- [ ] `npm run smoke:pack` passes
- [ ] Both generator `--check`s pass
- [ ] No test assertion changed. Mechanical edits to test files (import paths,
      `__dirname` depth) are expected when files move — changing what a test
      *asserts* is not.
- [ ] One commit per phase, prefixed `chore:` or `refactor:`
- [ ] Live proof captured via `cl_apply-local`
