# Handoff — Layout Cleanup

**Scope:** repository layout and module ownership. **No behavior changes.**
Every item below is a move, a rename, a generator, or a declaration. No runtime
semantics, no product surface, no test assertions, no dependency changes.

**Committed scope:** Phases 0–5 (~5 h). Phases 6–9 are the structural follow-on
(~2 days) — clearly marked, do **not** start them without the owner's go-ahead.

**Branch:** `release/1.6.0` (currently has substantial uncommitted work — see
Phase 0). Work in the **main checkout** at `/Users/oddle/Documents/canary-lab`,
never in `.claude/worktrees/*` — three stale worktrees exist there and are behind.

---

## Ground rules (non-negotiable)

These come from `CLAUDE.md` and the `cl_*` skills. Read the named skill before
touching the matching area.

| Rule | Why it matters here |
| --- | --- |
| **Never weaken, skip, or delete a test to make something pass** | Pinned by `apps/web-server/mcp/repair-guardrail.test.ts`. A layout refactor has no excuse to touch an assertion. |
| **Never add `/* v8 ignore */` pragmas** | Forbidden repo-wide. The coverage gate is 100/100/100/100 — if a move drops coverage, fix the config glob, not the gate. |
| **Never edit the prose that tells agents to fix the app, not the test** | `REPAIR_INSTRUCTIONS`, heal `MODE_COPY`, shipped `canary-lab-run` skills. |
| **Don't move `apps/web-server/prompts/`** | `tools/prepare-assets.mjs` hardcodes `apps/web-server/prompts` → `dist/apps/web-server/prompts`, and prompts load via `shared/prompts.ts` at runtime. Prompts stay put; they are assets, not source. |
| **Don't move `templates/`** | Ships only through the build. Any template-adjacent change needs `npm run smoke:pack`. |
| **Run-loop semantics → `cl_sync-agent-surfaces`** | Phase 8 only. A pure file move isn't a semantics change, but if an import path named in a skill or doc changes, the surfaces must be re-synced. |
| **Live proof** | `cl_verify-changes` Tier 3 says hand `canary-apply` to the user. This checkout has a gitignored `cl_apply-local` skill, which means this machine has opted in — invoke that skill instead of handing off. |

---

## Target shape

### TODAY — features own their logic and nothing else

```
canary-lab/
├── apps/
│   ├── web/src/
│   │   ├── features/                    10 features
│   │   │   ├── runs/                    components state api utils    7,389 ln
│   │   │   ├── flights/                 components state lib          7,281 ln
│   │   │   ├── config/                  components ONLY               5,995 ln
│   │   │   ├── logs/                    components ONLY  → /api/cleanup/*
│   │   │   └── … 6 more                 each a different subset
│   │   └── shared/
│   │       ├── api/client.ts            2,195 ln · 137 exports ← ALL 10 features
│   │       └── lib/ shell/ state/ ui/
│   └── web-server/
│       ├── server.ts                    1,523 ln · 61 dep constructions   ⟵ outside src/
│       ├── mcp/tools.ts                 2,740 ln · every tool in one file ⟵ outside src/
│       ├── prompts/                     assets
│       └── src/
│           ├── features/                10 features · runs = 15,024 ln (39%)
│           └── shared/
├── scripts/                             ⟵ this is the published CLI (bin)
├── tools/                               ⟵ this is the build tooling
├── shared/                              public API (4 exported paths) + internals, unmarked
├── .claude/skills/          20          source of truth
├── .agents/skills/          20          orphan · 13 stale
├── .codex/skills/           12          8 missing → AGENTS.md points at dead paths
├── History                              320 KB SQLite, tracked
├── package-lock.json + yarn.lock        both tracked
├── templates/  docs/
└── 0 feature barrels · 211 cross-feature imports · 599 deep relative imports
```

### AFTER PHASE 5 — the committed ~5 h scope: names tell the truth

```
canary-lab/
├── apps/
│   ├── cli/                             ← was scripts/ · bin: dist/apps/cli/cli.js
│   ├── web/                             unchanged in this scope
│   └── web-server/
│       ├── prompts/                     assets — deliberately outside src/, documented
│       └── src/
│           ├── server.ts                ← moved in
│           ├── mcp/                     ← moved in · tools split by profile
│           ├── features/
│           └── shared/
├── tools/                               now unambiguously build-only
├── shared/
│   └── README.md                        ← names the 4 exported paths as public API
├── .claude/skills/          20          source of truth
├── .codex/skills/           19          GENERATED + --check (cl_apply-local excluded)
├── templates/  docs/
└── gone: .agents/ · History · yarn.lock         aliases replace 599 deep imports
```

Still true after Phase 5: one god client, one god composition root, `runs` at 39%,
zero barrels. Those are Phases 6–9 — the layout is honest, the ownership is not yet.

### AFTER PHASE 9 — the follow-on scope: a feature owns its whole seam

```
apps/web-server/src/features/<name>/          apps/web/src/features/<name>/
├── index.ts   register(app, deps)  NEW       ├── index.ts   public surface  NEW
├── logic/                                    ├── api/       its slice of client.ts  NEW
├── routes/                                   ├── components/
└── ws/        only if it has a               └── state/
              realtime surface — documented

server.ts            → ~10 register() calls + the stores it genuinely owns
shared/api/client.ts → the apiFetch wrapper only
runs (15,024 ln)     → 4 features: run store · runtime · heal · journal   (names TBD)
                       this is what breaks the runs ⇄ config cycle
+ lint rule: no ../../<other-feature>/… imports
```

---

## Phase 0 — Baseline (do not skip)

You cannot tell a layout regression from a pre-existing failure without this.

```bash
git status --short > /tmp/baseline-dirty.txt && wc -l < /tmp/baseline-dirty.txt
npx tsc -p tsconfig.build.json --noEmit && echo "TYPECHECK OK"
npm run typecheck:web && npm run typecheck:server
```

```bash
rm -rf coverage && npx vitest run --coverage --no-file-parallelism 2>&1 | tail -30
```

Record: the four coverage percentages, the test count, and the exit code.

- The gate is **100/100/100/100** in `vitest.config.ts`. If the baseline is not
  100%, **stop and report** — do not start moving files onto a red gate.
- Coverage has a known `coverage/.tmp` ENOENT race. The `rm -rf coverage` +
  `--no-file-parallelism` form above is the reliable one.
- A full `npx vitest run` is known to get SIGTERM'd on the wall clock (**exit
  143/144**) while reporting 0 failures. **143/144 is inconclusive, not green** —
  re-run scoped to the affected paths.

Commit or stash nothing. The branch's existing uncommitted work stays as-is; your
commits land on top of it.

---

## Phase 1 — Hygiene (~30 min)

### 1a. Fix the contributor-skill drift (live breakage)

Current state, measured:

| Location | Skills | Status |
| --- | --- | --- |
| `.claude/skills/` | 20 | source of truth |
| `.agents/skills/` | 20 | **orphan** — referenced by nothing; 13 stale vs `.claude` |
| `.codex/skills/` | 12 | **8 missing** |

`AGENTS.md` is generated from `CLAUDE.md` by `tools/gen-agents-md.mjs`, which
rewrites every `.claude/skills` path → `.codex/skills`. It names 20 skills. Eight
of those paths do not exist on disk:

```
cl_verify-the-premise        cl_flight-progress-model
cl_reuse-shared-logic        cl_locate-agent-session-logs
cl_manage-prompts            cl_apply-local
cl_route-every-surface       cl_run-evidence-invariants
```

Four are the ones `CLAUDE.md` calls load-bearing. `cl_run-evidence-invariants`
pins the repair rule and exists **only** in `.claude/skills/`.

**Do:**

1. Extend `tools/gen-agents-md.mjs` (or add `tools/gen-codex-skills.mjs` beside
   it) to copy `.claude/skills/*` → `.codex/skills/*`, with a `--check` mode that
   exits non-zero when stale. Mirror the existing banner convention: generated
   files say DO NOT EDIT and name the regen command.
2. **Exclude `cl_apply-local`** from the copy. It is gitignored and local-only —
   `.gitignore` has `.claude/skills/cl_apply-local/`. It must never ship into a
   tracked directory. Remove its name from `CLAUDE.md`'s skill list too, or the
   generated `AGENTS.md` keeps advertising a path that will not exist for anyone
   else.
3. Wire `--check` into `npm run smoke:pack` next to the existing AGENTS.md check.
4. `git rm -r .agents/` — nothing references it.
5. Add `.codex/skills/` regeneration to `npm run build` alongside `gen:agents`.

**Verify:**

```bash
node tools/gen-agents-md.mjs --check && echo "AGENTS.md fresh"
diff <(ls .claude/skills) <(ls .codex/skills)   # expect only cl_apply-local
diff <(ls .claude/skills | grep -v cl_apply-local) <(grep -o 'cl_[a-z-]*' CLAUDE.md | sort -u)
npm run smoke:pack
```

### 1b. Untrack root clutter

```bash
git rm --cached History && echo "History" >> .gitignore
git rm yarn.lock
```

- `History` is a 320 KB SQLite database committed in `c5f0395`. Confirm with
  `file History` before removing; it is an editor/browser artifact, not project data.
- `yarn.lock` and `package-lock.json` are both tracked and were last touched in
  the same commit. Every documented command uses npm — keep `package-lock.json`.
- Untracked `canary-lab-1.6.0.tgz` and `.covtmp-openbrowser-run.log` are already
  covered by `*.tgz` / `*.log` in `.gitignore`. Leave them; they are local only.

**Verify:** `git status --short` shows only your intended changes; `npm ci` still
resolves.

**Commit:** `chore: generate codex skills from claude skills, drop tracked clutter`

---

## Phase 2 — Path aliases (~1 h) · **prerequisite for Phases 4, 5, 7**

`apps/web/tsconfig.json` already defines `@/*` → `src/*`. It has **0 uses**
against 605 relative imports. 599 imports repo-wide go up 3+ levels; 150 of them
go up 6–8 (`from '../../../../../../'`).

Do this **before** any move, or you will rewrite the same import paths twice.

**Do:**

1. Add aliases in the three tsconfigs *and* `apps/web/vite.config.ts` +
   `vitest.config.ts` (`resolve.alias`) so type-resolution and runtime agree:
   - `@web/*` → `apps/web/src/*` (or keep `@/*` for web-internal use)
   - `@server/*` → `apps/web-server/src/*`
   - `@shared/*` → `shared/*`
2. Codemod imports that cross a feature or app boundary. **Leave same-directory
   and single-level (`./`, `../`) imports alone** — aliasing those hurts
   readability and inflates the diff.
3. Verify no alias resolves into `dist/` or `apps/web/dist/`.

**Verify:** all three typechecks, then `npx vitest run` scoped to changed dirs.
Zero behavior change means zero test edits — if a test needs touching, the alias
config is wrong.

**Commit:** `refactor: use path aliases for cross-boundary imports`

---

## Phase 3 — Naming alignment (~45 min)

Two concepts have different names on the two sides, and one has no owner.

| Web feature | Server side today | Problem |
| --- | --- | --- |
| `logs` (`LogCleanupPage`, 1,095 ln) | `/api/cleanup/runs` + `/api/cleanup/worktrees` in `runs/routes/runs.ts`, `/api/cleanup/portify` in `portify/routes/portify.ts` | One web feature, no owning server feature; the API surface is split across two |
| — | `version` (311 ln) | No web counterpart |

**Do:** pick one name per concept and apply it in both apps. Recommended:
rename the web feature `logs` → `cleanup` to match the `/api/cleanup/*` surface it
actually consumes, and leave the routes where they are — they are legitimately
owned by the features that own the data being cleaned. Document that split in
`docs/ARCHITECTURE.md` so the next reader does not go looking for a `cleanup`
server feature.

Do **not** invent a server `cleanup` feature to mirror the web one. That would
mean moving run and portify cleanup logic away from the stores they read.

**Also in this phase:** mark the public/internal split in root `shared/`.
`package.json` `exports` maps four paths out of it — `shared/configs/playwright.base`,
`shared/configs/loadEnv`, `shared/e2e-runner/log-marker-fixture`,
`shared/launcher/types`. Those are semver surface. `shared/flights`,
`shared/coverage`, `shared/lib`, `shared/run-state`, `shared/runtime`,
`shared/cli-ui` are internal, and nothing distinguishes them.

Cheapest correct fix: a `shared/README.md` naming the four exported paths as
public API plus a comment above the `exports` block pointing back at it. A
directory split (`shared/public/`) is cleaner but changes four published paths —
that is a breaking change for consumers and is **out of scope**.

**Verify:** Tier 1 + `npm run smoke:pack` (exports are packaging surface).

**Commit:** `refactor: align cleanup naming across apps, mark shared public API`

---

## Phase 4 — `web-server` top level into `src/` (~2 h)

Today `apps/web-server/` has `src/` plus three stray peers:

| Path | Lines | Target |
| --- | --- | --- |
| `server.ts` | 1,523 | `src/server.ts` |
| `mcp/` | — | `src/mcp/` |
| `prompts/` | — | **stays** (assets — see ground rules) |

**Do:**

1. `git mv apps/web-server/server.ts apps/web-server/src/server.ts`
2. `git mv apps/web-server/mcp apps/web-server/src/mcp`
3. Move `server.runfullcycle.test.ts` and `server.smoke.test.ts` alongside.
4. Fix the 1 import of `../server` and the 3 of `mcp/tools'`.
5. Split `mcp/tools.ts` (2,740 lines) by tool profile. Use `cl_add-mcp-tool`
   first — it owns the tool-count smoke expectations and the rules for sizing
   what a tool returns. The smoke test asserts a tool count; a split must keep it
   identical.

**Config obligations — miss one and the coverage gate silently changes shape:**

| File | Change |
| --- | --- |
| `vitest.config.ts` coverage `exclude` | `'apps/web-server/server.ts'` → `'apps/web-server/src/server.ts'` |
| `vitest.config.ts` test `include` | `'apps/web-server/**/*.test.{ts,tsx}'` still matches — verify, don't assume |
| `tsconfig.web-server.json` | **no change** — its `include` is the broad `apps/web-server/**/*.ts` |
| `docs/ARCHITECTURE.md` + `.claude/skills/` | 4 refs to `apps/web-server/server.ts`, **17 refs to `apps/web-server/mcp/`** |

Note: coverage `include` covers `src/features/**/logic/**`, `src/features/**/routes/**`,
and `src/shared/**` — so `src/server.ts` and `src/mcp/` land **outside** the gate,
same as today. That is intentional (thin I/O glue). The stale `exclude` line must
still be updated or it becomes dead config.

**Verify:** Tier 1, then `npm run smoke:pack` (MCP tool counts), then Tier 3 via
`cl_apply-local` — this is a server-boot path, and a broken import here fails at
runtime, not at typecheck.

**Commit:** `refactor: move web-server entry and mcp under src/` +
`refactor: split mcp tools by profile`

---

## Phase 5 — `scripts/` → `apps/cli/` (~1 h)

`scripts/` is the published CLI (`bin: dist/scripts/cli.js`), 20 modules. `tools/`
holds the real build scripts. The names are inverted against convention.

**Do:** `git mv scripts apps/cli`, then update every path-bearing config:

| File | Line | Change |
| --- | --- | --- |
| `package.json` | `bin` | `dist/scripts/cli.js` → `dist/apps/cli/cli.js` |
| `package.json` | `e2e:flight` | `tsx scripts/e2e-flight-drive.ts` → `apps/cli/…` |
| `tsconfig.json` | `include` | `"scripts/**/*"` → `"apps/cli/**/*"` |
| `tsconfig.build.json` | `include` | same |
| `vitest.config.ts` | test `include` | `'scripts/**/*.test.ts'` → `'apps/cli/**/*.test.ts'` |
| `vitest.config.ts` | coverage `include` | `'scripts/upgrade-migration.ts'`, `'scripts/upgrade-known-prompts.ts'` → `'apps/cli/…'` |

`tsconfig.build.json` has `rootDir: "."`, so output mirrors source paths — the
`bin` path change follows mechanically. Also update the comment in
`scripts/mcp-registration.ts:39`, which names `dist/scripts/mcp-registration.js`.

**10 doc/skill references to `scripts/`** need updating (`docs/`,
`.claude/skills/`, `CLAUDE.md`, `README.md`) — including the module-map row in
`docs/ARCHITECTURE.md:39`.

**Verify:** Tier 1 + Tier 2. `npm run smoke:pack` is **mandatory** here — it is
the only check that proves the published `bin` still resolves inside the tarball.
Then confirm `npx canary-lab --help` works from the installed tarball.

**Commit:** `refactor: rename scripts/ to apps/cli/`

---

## ⛔ STOP HERE for the committed ~5 h scope

Report back with: the phases landed, the coverage numbers vs. the Phase 0
baseline, `smoke:pack` result, and the live-proof result from `cl_apply-local`.

Phases 6–9 change 200+ import sites and touch the run loop. **Get explicit
go-ahead before starting.**

---

## Phase 6 — Per-feature `register()` (~3 h, needs go-ahead)

`server.ts` is 1,523 lines: 81 imports (65 into feature internals), 61 dependency
constructions, 23 route registrations, 1 inline handler. No feature can be added
or removed without editing it.

**Do:** give each server feature a `features/<name>/index.ts` exporting
`register(app, deps)`. `server.ts` keeps the store construction it genuinely owns
and becomes ~10 register calls.

Order matters: do this before Phase 9, because the barrel that Phase 9 needs is
the same file.

---

## Phase 7 — Slice `client.ts` (~3 h, needs go-ahead)

`apps/web/src/shared/api/client.ts` is 2,195 lines with 137 exports, imported by
all 10 web features. Exports already group by domain prefix (`Portify*`, `Flight*`,
`Run*`, `Envset*`, `Coverage*`…). Move each group to `features/<name>/api/`; keep
the shared `apiFetch` wrapper in `shared/api/`.

> **⚠ The single biggest trap in this document.** `vitest.config.ts` coverage
> `include` lists `'apps/web/src/shared/api/**/*.ts'`. `apps/web/src/features/*/api/**`
> is **not** in the include list. Moving those exports drops 2,195 lines out of
> the 100% gate while the gate still reports 100%. You **must** add
> `'apps/web/src/features/*/api/**/*.ts'` to coverage `include` in the same commit.
> Confirm the covered-file count against the Phase 0 baseline, not just the
> percentage.

---

## Phase 8 — Split `runs` (~4 h, needs go-ahead)

Server `runs` is 15,024 lines / 54 files — 39% of all server feature code, holding
four separable concerns that already live in separate subdirs: the run store,
`runtime/` (orchestrator, launcher, scheduler), `logic/heal/`, and journal/panes.
Splitting it also breaks the `runs ⇄ config` cycle, which runs through config types
the store needs.

**Required reading first:** `cl_sync-agent-surfaces` (run-loop semantics),
`cl_run-evidence-invariants` (anything producing a verdict), and `cl_add-mcp-tool`
if tool paths move.

> **⚠ Coverage-gate trap.** Four files inside `runs` are named by **exact path**
> in `vitest.config.ts` coverage `exclude`, each with an audited branch-by-branch
> rationale comment:
>
> ```
> apps/web-server/src/features/runs/logic/runtime/orchestrator.ts
> apps/web-server/src/features/runs/logic/runtime/log-enrichment.ts
> apps/web-server/src/features/runs/logic/runtime/env-switcher/switch.ts
> apps/web-server/src/features/runs/logic/playwright-list.ts
> ```
>
> (`logic/heal/` is **not** excluded — it is fully gated.) Re-derive the current
> list before moving anything:
>
> ```bash
> grep -oE "'apps/web-server/src/features/runs/[^']*'" vitest.config.ts
> ```
>
> Move any of them and the exclude goes stale → the file re-enters the gate below
> 100% → **the gate goes red**. Update the paths in the same commit and carry the
> rationale comments across verbatim. Do not "fix" the resulting red gate by
> deleting an exclude, adding a pragma, or relaxing a threshold.

**Verify:** Tier 1 + Tier 3 + **Tier 4** — drive the MCP heal loop end to end
against the `broken_todo_api` sample (`start_run` with `claim_heal` →
`wait_for_heal_task` → fix → `signal_run` → wait). 15 doc/skill refs to
`features/runs/` need updating.

---

## Phase 9 — Barrels + boundary lint (~2 h, needs go-ahead)

Zero of 20 features expose an `index.ts`. 211 cross-feature imports reach into
siblings' internals: 57 in `apps/web` (27 distinct edges), 154 in `apps/web-server`
(35 distinct edges). Cycles in both apps: `runs ⇄ config`, and
`config → portify → runs → config`.

**Do this last.** Before Phases 6–8 it would only document the current coupling;
after them, the barrels are nearly free. Add a lint rule forbidding deep sibling
imports (`../../<other-feature>/…`) so the seam cannot re-erode.

Also land the missing convention doc in `docs/ARCHITECTURE.md`: which per-feature
subdirs are required and which are optional. Today the convention is nominal —
`logic/` is universal, `routes/` is absent from `agent-sessions`, `ws/` exists in
4 of 10 server features, and web `config` is 5,995 lines of components with no
state or api layer. A feature with no realtime surface *should not* have an empty
`ws/`; the problem is that nothing says so, so nothing can check it.

---

## Verification ladder (from `cl_verify-changes`)

| Phase | Tiers |
| --- | --- |
| 1 (skills/clutter) | 1 + 2 |
| 2 (aliases) | 1 |
| 3 (naming, shared API) | 1 + 2 |
| 4 (web-server `src/`) | 1 + 2 + 3 |
| 5 (`apps/cli/`) | 1 + 2 |
| 6, 7, 9 | 1 + 3 |
| 8 (split `runs`) | 1 + 3 + 4 |

- **Tier 1:** `npx vitest run <changed paths>` + `npx tsc -p tsconfig.build.json --noEmit`.
  Scope the run. Exit 143/144 = inconclusive, re-run scoped.
- **Tier 2:** `npm run smoke:pack` — the only check that proves `dist/`, `bin`,
  templates, prompts, and exports.
- **Tier 3:** invoke `cl_apply-local`. Derive the port from
  `canary-lab.config.json` / `~/.canary-lab/active-servers.json` — **never
  hardcode 7421**; this workspace has flipped ports.
- **Tier 4:** MCP heal loop against `broken_todo_api`.

**Contributor-docs audit** — run after any phase that renames or moves a path:

```bash
diff <(ls .claude/skills) <(grep -o 'cl_[a-z-]*' CLAUDE.md | sort -u)
grep -rn 'agent-integrations/[a-z]*/skills/[a-z-]*/SKILL.md' docs/ .claude/skills/
find agent-integrations -name SKILL.md | wc -l
```

A hardcoded path list in a doc is a finding — prefer a discovery command in the
prose over an enumeration.

---

## Definition of done

- [ ] Coverage is 100/100/100/100 **and** the covered-file count matches the
      Phase 0 baseline (percentage alone does not prove scope was preserved)
- [ ] All three typechecks pass
- [ ] `npm run smoke:pack` passes
- [ ] `node tools/gen-agents-md.mjs --check` and the new skills `--check` pass
- [ ] Zero test files modified — this refactor changes no behavior. Any test edit
      is a signal something is wrong; report it instead of adapting the test.
- [ ] Doc/skill references updated: 10 for `scripts/`, 17 for
      `apps/web-server/mcp/`, 4 for `server.ts`, 15 for `features/runs/`
- [ ] One commit per phase, message prefixed `chore:` or `refactor:`
- [ ] Live proof captured via `cl_apply-local` for Phases 4, 6–9

## Baseline facts (measured 2026-07-26, `release/1.6.0` @ `15fd6ea`)

Re-measure rather than trusting these if time has passed.

| Metric | Value |
| --- | --- |
| Source lines / files | 89,141 / 338 src, 288 test |
| Server features | 10 (`runs` 15,024 ln = 39%) |
| Web features | 10 (`flights` 7,281 · `runs` 7,389 · `config` 5,995) |
| Cross-feature imports | 57 web (27 edges) · 154 server (35 edges) |
| Feature barrels | 0 / 20 |
| Deep relative imports (3+) | 599 (150 at 6–8 levels) |
| `@/*` alias uses | 0 |
| `client.ts` | 2,195 ln, 137 exports, all 10 web features import it |
| `server.ts` | 1,523 ln, 81 imports, 61 dep constructions, 23 registers |
| Coverage gate | 100/100/100/100, hand-curated include (9 globs) + exclude (8 file-specific) |
| Illegal app edges | 0 (`web ↔ web-server`, `shared → apps`) — keep it that way |
