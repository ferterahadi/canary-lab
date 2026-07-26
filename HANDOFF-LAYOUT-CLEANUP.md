# Handoff — Layout Cleanup

**Scope:** repository layout and module ownership. **No behavior changes.**
Every item below is a move, a rename, a generator, or a declaration.

**Status:** Phases 0–7 are **done and committed**. Phase 8 has **steps 1, 3, 4, 5
and 6 done** and step 2 partly done (one of five clusters); Phase 9 has not
started. The one
non-layout item (a public-repo privacy exposure) is **resolved** — the history
was rewritten on 2026-07-26, so **every SHA below is post-rewrite**.

**Branch:** `release/1.6.0`. Work in the **main checkout** at
`/Users/oddle/Documents/canary-lab`, never in `.claude/worktrees/*` — three stale
worktrees exist there and are behind.

---

## What already landed (2026-07-26)

| Commit | Phase | Result |
| --- | --- | --- |
| `70c3a68` | 1 | `tools/gen-codex-skills.mjs` mirrors `.claude/skills` → `.codex/skills` (19 files, `cl_apply-local` excluded); `.agents/` + `yarn.lock` removed; `History` untracked |
| `c074457` | 2 | 406 boundary-crossing imports in `apps/web` → `@/…` / `@shared/…`; zero 3+-level relative imports remain |
| `1c95ab8` | 3 | web feature `logs` → `cleanup`; `shared/README.md` marks the 4 published paths |
| `5f4f525` | 4 | `server.ts` + `mcp/` moved under `src/`; `tools.ts` 2,740 ln split into `tool-support.ts` + 4 `tool-groups/` |
| `3037458` | 5 | `scripts/` → `apps/cli/`; `bin` → `dist/apps/cli/cli.js` |
| `1162462`, `9c332cd` | — | fallout fix: a stale MCP registration is now reported instead of failing silently |
| `14c4d77`, `b8faded` | 6 | all 10 server features expose `register(app, ctx)`; `server.ts` 1,523 → 447 ln |
| `143e461` | 7 | `client.ts` 2,195 ln → a 24-line barrel + 13 domain modules + `internal.ts`, all still under `shared/api/`; zero call sites changed |
| `d93871b` | — | fallout fix: `run-primitives.ts` had shipped untested in `b8faded`, holding the gate red at 99.95% ever since |

`origin/release/1.6.0` is at `8c7d6c5`; **everything from `dd9ade7` onward is
unpushed.** These SHAs replaced the pre-rewrite ones (`2140974`, `4421b81`,
`02ddf2a`, `f8438d8`, `459fb0f`, `d14ad04`, `a0107e7`, `a4bb2f0`, `298378a`); the
old hashes no longer resolve. `.git/filter-repo/commit-map` holds the full mapping
if an old SHA turns up in a doc or a note.

### Current numbers (measured at `5195214`)

| Metric | Value |
| --- | --- |
| Coverage gate | 100/100/100/100 — **182 files**, 12,997 stmts / 8,718 branches / 2,431 funcs / 11,202 lines |
| Tests | 305 files, 5,603 passing, 1 skipped |
| `tsc -p tsconfig.build.json` | clean |
| `typecheck:web` / `:server` | 5 / 17 pre-existing errors, **all in `*.test.ts(x)`** (the build config excludes tests) — this is the baseline, not a regression. Count *errors* (`grep -cE "^[^ ].*error TS"`), not output lines; multi-line errors inflate a `wc -l`. |
| `server.ts` | 447 ln, 58 imports, 15 dep constructions, 10 register calls |
| `shared/api/` | 15 modules, largest `config.ts` at 373 ln (was one 2,195-ln `client.ts`) |
| server `runs` | **2,781 ln excluded from the gate**, down from 5,068 at the start of Phase 8 |
| `orchestrator.ts` | 2,781 ln — the only file in `runs` still excluded, and still the largest file in the repo |
| `apps/web-server/src/shared/` | 15 modules; gained `feature-loader`, `ast-extractor`, `config-ast`, `launcher-startup` |
| Feature barrels | server 10/10 · **web 0/10** ← Phase 9 target |
| Cross-feature imports | **web 57** (aliased `@/features/<other>/…`) · **server 257** |

The earlier revision of this table claimed 162 files / 100% at `b8faded`. Both were
wrong: the gate had been red since Phase 6 (`run-primitives.ts` shipped untested),
and "web 0 cross-feature imports" counted only the pre-codemod `../../` spelling.
Re-measure rather than copying a number forward.

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

## Phase 7 — Slice `client.ts` ✅ done (`143e461`)

Split **in place** into `shared/api/{features,coverage,benchmark,portify,config,
workspace,runs,verification,evaluation,agent-sessions,cleanup,wizard,flights}.ts`
plus `internal.ts` (the `ApiError`/`request`/`defaultOpts` core), with `client.ts`
left as a 24-line barrel. **No call site changed** — all 81 consumers, including
the 46 using `import * as api`, still import `'./client'`.

**The written plan said to move each group to `features/<name>/api/`. Don't — the
partition it assumed does not exist.** Grouping the 180 exports by *consumer*
rather than by name prefix:

| Class | Count |
| --- | --- |
| used by exactly 1 feature | 110 |
| used by **2+ features** | 30 |
| used by `shared/` or the app root | 12 |
| dead — no consumer anywhere | 17 |
| test-only — `client.test.ts` alone | 11 |

Prefixes actively mislead: `getFeatureConfig` / `getFeatureCoverage` /
`getFeatureTests` / `getFeatureDirtyDiff` belong to four different features, while
`listRuns`, `getRunDetail`, `restartRun`, `stopRun`, `cancelHealRun` and
`listJournal` are shared by flights **and** runs because `TestRunPanel.tsx`
deliberately mirrors the run feature. Moving those 30 into an owning feature would
manufacture the cross-feature imports Phase 9 exists to forbid.

Splitting inside `shared/api/` also sidesteps the coverage trap entirely: the
existing `'apps/web/src/shared/api/**/*.ts'` glob already matches the new siblings,
so nothing had to change in `vitest.config.ts` and the denominator never moved.
**If a later phase does move these into `features/*/api/`, that glob is not in the
`include` list** — add `'apps/web/src/features/*/api/**/*.ts'` in the same commit,
and confirm with the file count, not the percentage:

```bash
grep '^SF:' coverage/lcov.info | wc -l   # 177 today; a drop means scope was lost
```

**Technique worth reusing.** The wrapper bodies were proven unchanged rather than
reviewed: the slices tile lines 102..EOF with no gap or overlap, and each domain
file's body compares equal to the concatenation of its slices. Per-file import
headers were then recomputed from what each body actually references — not
hand-pruned and not regex-stripped.

---

## Phase 8 — Split `runs` (in progress)

> **⚠ The stated goal was already met before Phase 8 started.** `runtime/`,
> `routes/`, `heal/`, `dirty-specs/` and `ws/` all exist and always did — there is
> no directory split to perform. Re-derived from the code, the debt Phase 8 was
> pointing at is that **5,068 lines of `runs` sit outside the coverage gate**, all
> four excluded files being here, and `orchestrator.ts` is the largest file in the
> repo. That is the thing to finish. Likewise the claimed `runs ⇄ config` cycle is
> **one** back-edge (`loadFeatures` in the registrar) against 12 imports the other
> way — real, but not the structural knot the plan described.

### Remaining work, measured

| # | Item | Size | State |
| --- | --- | --- | --- |
| 1 | `run-verdict.ts` — verdict layer out of `orchestrator.ts` | 558 ln | ✅ `dd9ade7`, gated at 100% |
| 2 | `RunOrchestrator` class | 2,404 → 2,323 ln, 62 methods | 🔶 first cluster out (`5195214`); four remain |
| 3 | Orchestrator tail — spawner, PTY, prompts | 146 ln | ✅ `253027b`, gated at 100% |
| 4 | `log-enrichment.ts` | 1,094 ln | ✅ `659d167`, exclude deleted |
| 5 | `runs → config` coupling | 8 imports → 0 | ✅ `f1f960c` |
| 6 | Tier-4 live proof + DoD checklist | — | ✅ 3/3 passed on run `2026-07-26T1322-3eg4` |

**Net so far:** `runs` outside the gate **5,068 → 2,781 ln** (−45%), gated files
**177 → 182**, and **no new exclude was added at any step**. `orchestrator.ts` is
the only file in `runs` still excluded.

### What remains — step 2, clusters 2–5

Measured with its exclude lifted, `orchestrator.ts` is at **95.3% statements /
89.2% branches**, and the uncovered arms are *concentrated in the heal loops*,
not spread evenly. So the way forward is to keep lifting out clusters that can
stand alone, exactly as clusters already landed did — not to chase arms inside
the class.

| Cluster | Lines | Note |
| --- | --- | --- |
| ✅ Agent session refs | ~90 | done — `AgentSessionRefStore`, 18 tests |
| Heal-agent PTY (spawn, cleanup, output tail) | ~460 | biggest remaining |
| Auto/manual heal loops | ~400 | **where the uncovered branches are**; hardest, do last |
| Service boot + readiness polling | ~250 | mostly covered already; low risk |
| Playwright invocation + artifacts | ~250 | mostly covered already; low risk |
| Repo snapshot / fix capture / overlay | ~230 | — |

Take the low-risk covered clusters first: moving already-covered code out of an
excluded file still *adds* it to the gate, so each one is a win with almost no
regression surface. Leave the heal loops for last.

The class has five clusters worth separating: heal-agent PTY + session refs
(1553–2104, ~550 ln), auto/manual heal loops (2325–2725, ~400 ln), service boot
and readiness polling (880–1126, ~250 ln), Playwright invocation and artifacts
(1179–1436, ~250 ln), and repo snapshot / fix capture / overlay (693–853 plus
2105–2172, ~230 ln).

### Step 1 — `run-verdict.ts` ✅ done (`dd9ade7`)

`orchestrator.ts` 3,508 → 2,986 ln; the excluded surface shrank 522 lines with
**no new exclude**. Nine module-private functions became exported, which is the
only reason they had never been unit-tested — previously they were reachable
solely by driving a live orchestrator. 31 tests took the new module to 100%.

Two findings worth carrying into steps 2–4:

- **"Unreachable" is a claim to test, not to assert.** Six of the ten open
  branches were written off as unreachable in an earlier pass; five turned out to
  be reachable with a real input. The parser only sets `parseError` on a source
  deep enough to overflow its own recursion (plain bad syntax returns a test-less
  tree through a different arm), and the `file:line` de-duplication fires when two
  tests are declared on **one source line**. Probe the collaborator before
  concluding an arm is dead.
- **Genuinely dead arms get deleted, not excluded** — matching the six defensive
  arms already removed this release. `grepForKnownTests` could not return null, so
  its guard and the `if (!grep)` fallback are gone and the return type is now
  `string`, making a regression a compile error.

Server `runs` is 15,970 lines across these subdirs:

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
> As of `b8faded` that is `logic/runtime/orchestrator.ts`,
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
2. **Boundary lint** forbidding cross-feature imports so the seam cannot re-erode.

   > **⚠ "web 0" was a measurement artifact — web has 57.** The earlier count
   > looked for the relative spelling `../../<other-feature>/…`, which is genuinely
   > 0 — but only because the Phase 2 codemod rewrote every one of them to
   > `@/features/<other>/…`. The coupling was renamed, not removed. **A lint
   > written against `../../` passes trivially while changing nothing.** Target the
   > aliased form:
   >
   > ```bash
   > for d in apps/web/src/features/*/; do n=$(basename "$d");
   >   grep -rhoE "from '@/features/[a-z-]+" "$d" --include='*.ts*' \
   >     | sed "s|from '@/features/||" | grep -v "^$n\$"; done | wc -l
   > ```
   >
   > Today: flights 23, runs 11, coverage 5, evaluation 5, config 4, benchmark 3,
   > portify 3, wizard 3 — **57 total**, vs **server 257**. Some are deliberate
   > (`TestRunPanel.tsx` in flights reuses the runs feature's `RunRow` on purpose),
   > so decide what the rule permits before writing it.
3. **The missing convention doc** in `docs/ARCHITECTURE.md`: which per-feature
   subdirs are required and which are optional. Today the convention is nominal —
   `logic/` is universal, `routes/` is absent from `agent-sessions`, `ws/` exists in
   4 of 10 server features, and web `config` is ~6,000 lines of components with no
   state or api layer. A feature with no realtime surface *should not* have an empty
   `ws/`; the problem is that nothing says so, so nothing can check it.

Note the server barrels are **registrars**, not re-export barrels — `register(app,
ctx)` plus a returned handle. If you add re-exports, don't break that contract.

---

## ✅ Resolved — `History` blob purged (2026-07-26)

**`History` was a Chromium browsing-history database** (320 KB SQLite: `urls`,
`visits`, `downloads`, `keyword_search_terms`) committed in the old `c5f0395` and
pushed to **github.com/ferterahadi/canary-lab, which is PUBLIC**. Phase 1 untracked
and gitignored it; that stopped future commits but left it in the published history.

Content reviewed before removal: expired Google OAuth/session tokens (~3 months
old — `rapt`/`sidt`/`part`, all short-lived), a personal Gmail session, TikTok
developer app + org IDs, and a handful of searches. **No passwords, API keys, or
long-lived credentials.** A privacy exposure, not a credential leak.

Removed by the repo owner with `git filter-repo --path History --invert-paths
--force --refs release/1.6.0 ui-skin-unify`, then force-pushed. Verified: no ref or
reflog reaches `History`, and the two old commits are absent from the object store.

**Two things that nearly hid the blob after the rewrite** — both worth knowing if a
similar purge is ever needed:

1. **An orphaned `refs/stash`.** `git reflog expire --expire=now --all` wipes the
   stash *reflog*, so `git stash list` prints nothing while `refs/stash` still
   points at a stash commit rooted in the old history. Clear it with
   `git update-ref -d refs/stash`, not `git stash drop`.
2. **The remote-tracking reflog.** `.git/logs/refs/remotes/origin/<branch>` records
   `<old> <new>` for the force-push, and its **old** side pins the entire
   pre-rewrite chain. `reflog expire` cannot remove it — git never expires a
   reflog's newest entry. Delete the log file, then `git gc --prune=now`.

Diagnose both with `git log --all --reflog --oneline -- <path>` (the `--reflog` is
the part that catches them) rather than `git log --all`.

The local backup bundle and the extracted copy were deleted by the owner after
verification. Unreferenced objects stay fetchable by SHA on GitHub until their GC;
ask Support to purge cached views if that matters. Treat anything in those URLs as
disclosed regardless — the repo was public the whole time.

---

## Verification ladder (from `cl_verify-changes`)

| Phase | Tiers |
| --- | --- |
| ~~7 (slice `client.ts`)~~ | done — 1 + a production `npm run build` (the module graph is bundler-resolved, so a clean build proves more here than a live server) |
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
- **Group by consumer, not by name.** Phase 7's plan partitioned 183 exports by
  prefix and would have been wrong for 39% of them. `grep`ing each exported symbol
  across every feature dir took minutes and changed the whole shape of the phase.
- **A/B a red gate before you own it.** When coverage failed after the Phase 7
  split, stashing the work and re-running produced byte-identical numbers — proving
  the failure predated the change. Without that, the obvious move is to "fix"
  someone else's uncovered file inside your refactor commit.
- **A plan's premises expire.** Five in earlier versions of this document were false
  by the time they were acted on: aliases could not go repo-wide, `tools.ts` could
  not be split by profile (7 tools belong to several profiles at once), the
  `--check` it said was "already wired next to" had never been called, the coverage
  gate was not at 100% (`run-primitives.ts` shipped untested in Phase 6), and web's
  cross-feature import count was 57, not 0. **Verify before building.**

## Definition of done (Phases 8–9)

- [ ] Coverage 100/100/100/100 **and** the covered-file count at least 178
      (percentage alone does not prove scope was preserved; every file a split
      lifts out of an exclude should push this number *up*)
- [ ] All three typechecks at baseline (0 / 5 / 17, the latter two test-only)
- [ ] `npm run smoke:pack` passes
- [ ] Both generator `--check`s pass
- [ ] No test assertion changed. Mechanical edits to test files (import paths,
      `__dirname` depth) are expected when files move — changing what a test
      *asserts* is not.
- [ ] One commit per phase, prefixed `chore:` or `refactor:`
- [ ] Live proof captured via `cl_apply-local`
