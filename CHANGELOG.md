# Changelog

All notable changes to Canary Lab are listed here. We try to keep the language plain so anyone can follow along.
---
Each entry is tagged with the area it touches:

- **[Test Runner]** — running tests, run history, auto-heal, services, logs
- **[Test Generation]** — Add Test wizard, PRD/plan/spec drafting
- **[Export evaluation]** — exported evaluation reports
- **[Benchmark]** — self-heal benchmarking (retired in 1.0.0)
- **[General]** — UI shell, CLI, scaffolding, packaging

---
## 1.0.6 — 2026-05-15

- **[Test Runner]** **Better test discovery.** Tests defined through helpers are now picked up and reported correctly alongside everything else.
- **[Test Runner]** **Clearer run status.** Run state tracking is more accurate, so what you see in the UI matches what's actually happening.
- **[Test Runner]** **More reliable self-heal cycle.** The auto-heal loop holds up more dependably across iterations, with steadier handoffs between runs and heal attempts.
- **[Test Runner]** **Test-generation context carried into heal.** The PRD, supporting documents, skills, and descriptions you attach during test generation are now preserved on the test and surfaced to the agent during the heal cycle, so it has the original intent to work from instead of guessing from code alone.
- **[General]** **Fresh look.** The interface has been redesigned with cleaner styling including clearer run status indicators throughout.

---

## 1.0.5 — 2026-05-14

- **[Export evaluation]** **Plain-English evaluation report.** Exported evaluation reports now go through a rewrite pass that turns code-like test names, helper calls, and flowchart labels into clear descriptions of what each step is actually checking. The report reads like an operational summary instead of a dump of identifiers.
- **[Test Runner]** **Live agent activity view.** The agent session screen has been rebuilt to stream what's happening in real time, with a cleaner layout that's now shared across the setup wizard.
- **[Test Generation]** **Wizard task tracker** — see at a glance which wizard drafts are in progress, what stage they're at, and pick up where you left off.
- **[Test Generation]** **Smoother test setup wizard.** Reviewing specs and plans during test creation is tidier and less cluttered.
- **[Test Generation]** **Retired the skills recommender** — the experimental skills suggestion feature has been removed to make room for the new evaluation export workflow.
- **[General]** **Friendlier global status bar.** The bar at the top of the app reflects run state more accurately and reacts faster to changes.

---

## 1.0.4 — 2026-05-12

- **[Test Runner]** **Clearer run status at a glance** — Runs now show more accurate progress and outcome so you can tell what's happening without digging in.
- **[Test Runner]** **Lifecycle tracking for each run** — Canary Lab keeps a timeline of key moments during a run, making it easier to see what happened and when.
- **[Test Runner]** **More reliable run details** — The run detail view has been reworked to show information more consistently and update more smoothly.
- **[Test Runner]** **Steadier live updates** — Streaming updates while a run is in progress are more dependable.
- **[Test Runner]** **Better handling of run state** — Behind the scenes, runs track their own state more carefully so you'll see fewer odd or stale statuses.

---

## 1.0.3 — 2026-05-11

- **[Test Runner]** **Smoother agent sessions** — The live view of an agent working through a run is more reliable and easier to follow.
- **[Test Runner]** **Better terminal display** — Output in the terminal pane renders more cleanly and handles tricky cases without glitches.
- **[Test Runner]** **Steadier auto-heal** — When a run hits a snag, the automatic recovery picks up where it left off more dependably.

---

## 1.0.2 — 2026-05-11

- **[Test Runner]** **Cleaner history after auto-heal finishes.** Once the auto-heal agent stops, the run history shows a tidy, organized log of what it did instead of a wall of raw output.
- **[Test Runner]** **Auto-heal picks up where it left off.** If Claude needs to keep working on a fix across steps, it now continues the same conversation rather than starting fresh each time.
- **[Test Runner]** **Long heal runs no longer get cut off.** Previously the agent would stop after roughly 10 minutes; it now keeps going by resuming its session, so longer fixes can complete.
- **[Test Runner]** **More reliable run summaries.** End-of-run summaries handle tricky cases better and are less likely to look off.
- **[Test Runner]** **Steadier behavior under unusual conditions.** A range of edge cases around logging, run tracking, and live updates are handled more gracefully.

---

## 1.0.1 — 2026-05-11

> Re-run `npx canary-lab upgrade` to refresh the managed `CLAUDE.md` / `AGENTS.md` heal block — the heal signal body changed shape (see Breaking changes).

- **[Test Runner]** **Heal cycles now show a real diff.** Before each heal attempt, Canary Lab snapshots your repo, then captures exactly what the agent changed — no more confusion from unrelated dirty files.
- **[Test Runner]** **Diff appears in the diagnosis journal.** Every heal iteration in the journal now ends with a diff block showing what was edited that cycle.
- **[Test Runner]** **Tidier journal display.** Internal bookkeeping fields are hidden; `fix.file` / `fix.description` show as `files` / `fix description`.
- **[General]** **Resizable panels handle window resizes properly.** No more drift or clipping when you resize the window.

### Breaking changes

- **[Test Runner]** **Heal signal payload changed.** The `.restart` / `.rerun` body is now `{"hypothesis":"…","fixDescription":"…"}` — `filesChanged` is gone (Canary Lab detects edits from the git snapshot). The built-in heal prompt is already updated; custom prompts need to drop `filesChanged` and add `fixDescription`.
- **[Test Runner]** **Heal agents no longer touch prior-iteration outcomes.** The runner handles that bookkeeping itself.

---

## 1.0.0 — 2026-04-30

> The headline change: Canary Lab is now driven from a local web UI (`canary-lab ui`) instead of a stack of iTerm tabs. Run `npx canary-lab upgrade` after upgrading to refresh the managed `CLAUDE.md` / `AGENTS.md` blocks.

- **[General]** **New web UI (`canary-lab ui`).** Boots a local Fastify server on `http://localhost:7421` and opens it in your default browser. Three-column Finder-style layout: features on the left, run history in the middle, live PTY logs and journal viewer on the right. Pass `--no-open` to suppress the auto-launch (useful over SSH or in CI), `--port <n>` to bind a different port.
- **[General]** **Default workflow is now the web UI, not iTerm tabs.** The Quick Start in the README is `npm install && npm run install:browsers && npx canary-lab ui`. Test execution, envset edits, run review, and heal controls now live in the UI.
- **[General]** **macOS-only is no longer a hard constraint.** Services and the heal agent run inside `node-pty` pseudo-terminals owned by Canary Lab — no AppleScript, no iTerm, no Terminal.app. Linux support is now in reach (the runner itself is cross-platform; only auto-launching the browser falls back to `xdg-open` / `cmd start`).
- **[General]** **Coverage gate.** Business-logic modules are gated at ≥92% on all four metrics (statements, branches, functions, lines). Enforced in CI; no `/* v8 ignore */` pragmas anywhere — exclusions live at the config level.
- **[General]** **Legacy workflow commands removed.** `canary-lab run`, `canary-lab env`, and `canary-lab new-feature` are no longer public commands. Use `canary-lab ui` for runs, envsets, and feature configuration.
- **[General]** **iTerm / Terminal.app AppleScript launchers removed.** The `shared/launcher/iterm.ts` and `shared/launcher/terminal.ts` backends are gone, along with their AppleScript shims and tab-cleanup logic. Everything runs through `node-pty` now.
- **[Test Runner]** **Run history.** The last 20 runs are preserved under `logs/runs/<runId>/` — each with its own service logs, summary JSON, heal index, and `runner.log`. Older runs roll off automatically. You can browse, compare, and re-open them from the UI without re-running.
- **[Test Runner]** **Run-scoped diagnosis journal.** New heal iterations are written to `logs/runs/<runId>/diagnosis-journal.md`, with `logs/current/diagnosis-journal.md` as the manual-agent path for the active run. Existing root-level journals are left in place as legacy history.
- **[Test Runner]** **`runner.log` per run.** The orchestrator now writes its own progress (lifecycle events, signal handling, restart decisions) to `logs/runs/<runId>/runner.log` — so you can audit what *the runner* did, separately from what each service or the agent did.
- **[Test Runner]** **Playwright Playback.** Run detail now has a structured playback view with final screenshots, trace downloads, inline retained video, collapsed browser actions, and the raw Playwright terminal as a fallback.
- **[Test Runner]** **`.playwright-mcp` artifact capture.** When Playwright's MCP integration emits artifacts during a failure, they're collected into the per-failure folder under `logs/failed/<slug>/.playwright-mcp/` so the heal agent can find them next to the sliced service logs.
- **[Test Runner]** **Readline-prompted "Auto-heal on test failure?" flow removed.** The old terminal prompt is gone. Heal mode is selected and controlled from the web UI.
- **[Test Generation]** **Add Test wizard.** A guided flow inside the UI: PRD draft → skill recommender → plan → spec generation. The wizard streams Claude / Codex output live and lands a ready-to-run Playwright spec into the chosen feature.

### Breaking changes

- **[Test Runner]** **`logs/` layout changed.** Per-run artifacts now live under `logs/runs/<runId>/` rather than at the top of `logs/`. Symlinks at `logs/svc-*.log` etc. point at the latest run for backward-compat with skill files, but anything reading absolute paths under `logs/` will need to follow the new structure.
- **[General]** **iTerm-tab-based scripts are gone.** If you had wrapper scripts that grepped iTerm window titles or relied on AppleScript-driven cleanup, they will no longer find anything to act on.

---

## 0.9.4 — 2026-04-27

- **[Test Generation]** **New skill so Claude knows where tests go.** Run `npx canary-lab upgrade` to pick it up. When you ask Claude to add a Playwright test in a canary-lab project, it now reads a built-in guide that explains the feature folder layout, the right imports, and where files belong — instead of guessing and putting things in the wrong place.

---

## 0.9.3 — 2026-04-27

> Pure speed-up release. No new commands, no changes to how you use Canary Lab. Just less waiting between runs.

- **[Test Runner]** **Tests run faster overall.** The runner used to do bookkeeping work after every single test (extracting log slices, rebuilding the heal map) — even when nothing failed. Now it only does that work when there's actually a failure to heal, and skips the duplicate pass at the end of the run.
- **[Test Runner]** **Service startup is parallel, not one-at-a-time.** When your project has multiple services (say an API, a worker, and a frontend), the runner now waits on all their health checks at the same time instead of in sequence. If each service takes ~5 seconds to warm up, you save ~10 seconds per run on a 3-service setup.
- **[Test Runner]** **Less file thrash inside `logs/`.** Each service log is now read once per run no matter how many tests failed (used to be re-read per failure). The iTerm session-id cache file no longer rewrites itself when nothing changed.
- **[Test Runner]** **Dead `logs/pids/` code path removed.** Old code wrote `.pid` files for each service so restarts could find them. Nothing has actually written those files in a long time — the runner already locates services by checking which port they're listening on. We deleted the leftover reader code and the `logs/pids/` directory it created. No behaviour change; just less to read when you're poking around the codebase.

### Benchmark note

- **[Benchmark]** Wall-time savings depend heavily on your project shape. Single-service projects with no failures save ~half a second per cycle. Multi-service projects with several failures can save several seconds per cycle, mostly from the parallel health checks.

---

## 0.9.2 — 2026-04-25

> Run `npx canary-lab upgrade` inside existing projects to refresh the managed `CLAUDE.md` / `AGENTS.md` heal prompt.

- **[Benchmark]** **Cleaner heal index.** Failure messages in `logs/heal-index.md` no longer include terminal color codes like `[2m` or `[31m]`. The index keeps the simple list format that worked well for the heal agent, just without the visual noise.

### Benchmark note

- **[Benchmark]** The cleaned-up heal index gives the agent a clearer starting point during benchmarked self-heal runs. This does not add a new workflow; it simply removes noise from the same failure map the agent already reads first.

---

## 0.9.0 — 2026-04-24

> Run `npx canary-lab upgrade` to apply the managed-file changes (CLAUDE.md / AGENTS.md refresh and deprecated skill-file cleanup). Per-feature directories are user-owned, so their new shape — described under [Feature layout](#feature-layout) below — does not auto-apply.

- **[Test Runner]** **Selective service restart on heal.** When the heal agent writes `logs/.restart` with a `filesChanged` list, the runner now restarts only the services whose repo actually owns one of those files — untouched services keep running, which is faster and keeps their logs intact. If `filesChanged` is missing or a path falls outside every known repo (e.g. a shared package or test file), the runner warns and falls back to restarting everything, so behaviour stays safe when impact is unclear.
- **[Test Runner]** **Heal workflow moved into `CLAUDE.md` / `AGENTS.md`.** The merged Self-Heal Workflow now lives between `<!-- heal-prompt:start -->` and `<!-- heal-prompt:end -->` markers inside the managed block. Both the manual `self heal` flow and the auto-heal runner read from the same source — one workflow, one source of truth.
- **[Test Runner]** **`auto-heal` runner reads from `CLAUDE.md` / `AGENTS.md`** (claude / codex respectively) and extracts the heal-prompt section as its prompt.
- **[Test Runner]** **Service startup failure no longer kills everything.** When a service fails its health check, the runner now asks what you want to do: stop, self-heal manually, or hand it to Claude or Codex. Services and env files stay in place while you decide, so you can actually look at the logs.
- **[Test Runner]** **Removed deprecated skill files.** `.claude/skills/heal-loop.md`, `.claude/skills/self-fixing-loop.md`, `.codex/heal-loop.md`, `.codex/self-fixing-loop.md` — content consolidated into `CLAUDE.md` / `AGENTS.md`. `canary-lab upgrade` removes these files from existing installs.
- **[General]** **Per-feature `src/config.ts` removed.** Features now load `.env` directly from `playwright.config.ts` and read `process.env.GATEWAY_URL` (with an inline default) in helpers. One fewer layer of indirection for scaffold readers to follow.
- **[General]** **Removed `features/<name>/src/config.ts`** (and the empty `src/` dir) in all scaffolded features.
- **[General]** **Removed `features/<name>/.env.example`** in all scaffolded features. The same values already live in `envsets/local/<name>.env`.
