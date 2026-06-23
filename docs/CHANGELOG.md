# Changelog

All notable changes to Canary Lab are listed here. We try to keep the language plain so anyone can follow along.
---
Each entry is tagged with the area it touches:

- **[Test Runner]** — running tests, run history, auto-heal, services, logs
- **[Test Generation]** — Add Test wizard, PRD/plan/spec drafting
- **[Export evaluation]** — exported evaluation reports
- **[Portify]** — port-ification wizard, converting features to dynamic port allocation
- **[Cleanup]** — log and run history cleanup
- **[Benchmark]** — measuring how the repair loop performs compared to running tests without Canary Lab
- **[General]** — UI shell, CLI, scaffolding, packaging

---

## 1.4.0 — unreleased

- **[General]** **Healing from the CLI is back.** Heal claiming is no longer limited to Desktop clients — any interactive Claude or Codex session (Desktop *or* CLI) can own a heal loop again. The only sessions still blocked are the ones Canary Lab spawns itself for benchmarks and Portify, which must never claim the very run they're working on.

---

## 1.3.2 — 2026-06-16

- **[Test Runner]** **The healing agent sees the whole picture.** Failure evidence used to get clipped to fit — long error messages, prior-agent context, code diffs, and boot logs could lose their tail. Now nothing useful is dropped: the agent always gets the full content, or a clear pointer to the complete file on disk.
- **[Test Runner]** **Less noise in the failure logs.** Repetitive log lines (retry loops, health-check polls) are collapsed into a single line with a count and range, so the agent reads less and gets to the real signal faster. Identifiers like request IDs and IP addresses are kept intact, and the full untouched log is always one click away.

---

## 1.3.1 — 2026-06-15

- **[General]** **Lighter install.** Trimmed the packages shipped with Canary Lab so installing it downloads less and finishes faster.
- **[General]** **Fuller getting-started guide.** Expanded the README with more setup and usage details so new users can find their footing without digging.

---

## 1.3.0 — 2026-06-14

> MCP server is renamed to `Canary_Lab` — run `npx canary-lab setup --force` and restart your agent after upgrading.

- **[Portify]** **Run a feature that was never built for concurrency.** If a feature has hardcoded ports, it'll collide with anything else running at the same time. The port-ification wizard fixes that: an agent rewrites the ports to dynamic allocation, you review and revise, and the change lands as a reversible overlay before anything is committed.
- **[Cleanup]** **Reclaim disk space without leaving the UI.** Old run logs pile up fast. A new cleanup panel lets you see what's there, filter to boot sessions, and remove what you no longer need — no file manager required.
- **[Benchmark]** **Groundwork for pluggable harnesses** *(preview — enable with `?showBenchmark=true`).* The goal is a future where you can slot in any harness and measure whether it actually helps. For now it runs the same tests with and without Canary Lab and puts the outcomes side by side.
- **[Test Runner]** **Know which services came up without reading the logs.** Boot-only runs now show a readiness result per service the moment startup finishes — pass, fail, or timeout at a glance.
- **[General]** **MCP server renamed to `Canary_Lab`.** Run `npx canary-lab setup --force` and restart your agent after upgrading, otherwise the tools won't appear.
- **[General]** **MCP health badge and connect guide.** The UI now shows whether your agent is connected, and a new guide walks you through linking Claude Desktop, Codex, or other clients when it isn't.
- **[General]** **Heal claims limited to Desktop clients.** CLI-connected agents can read run state and failure evidence but can no longer claim heals — that stays with the Desktop client driving the session.
- **[General]** **Port changes no longer break your agent session.** The MCP bridge now watches the live server record and reconnects automatically when the port changes.

---

## 1.2.0 — 2026-06-01

> Run `npx canary-lab upgrade` to refresh your sample features so they pick up per-run ports for concurrent runs.

- **[Test Runner]** **Run several things at once.** You can now have multiple test runs going at the same time instead of waiting for one to finish, as long as their services don't share a port. When your machine is busy, extra runs are parked in a queue and started as soon as there's room. And if you start a second run on a project that's already busy, you choose whether to run it in an isolated copy or have it wait.
- **[Test Runner]** **Boot your services without running tests.** A new mode lets you start an app's services on their own, without kicking off a test run, so you can poke at the running app yourself. It's handy for manual exploration, reproducing an issue by hand, or just confirming a service comes up cleanly before you commit to a full run.

---

## 1.1.0 — 2026-05-28

> The headline change: Canary Lab can now be driven from Codex Desktop, Claude Desktop, and other MCP clients. After upgrading, run `npx canary-lab setup` to refresh the local MCP registration.

- **[General]** **MCP support.** Codex and Claude can now connect to Canary Lab directly, start runs, inspect failures, and continue the work from the agent chat.
- **[Test Runner]** **External repair flow.** A connected agent can take over a failing run, read the saved evidence, make a fix, and ask Canary Lab to rerun or restart.
- **[Test Generation]** **Agent-driven feature work.** External agents can create features, add notes, apply generated tests, and prepare evaluation exports.
- **[General]** **Cleaner UI.** Run details, external repair, verification, export, and status screens have been tightened up with clearer labels, less clutter, and steadier status updates.

---
## 1.0.8 — 2026-05-17

- **[Export evaluation]** **Missing videos in exported evaluations.** Fixes a case where exported evaluations were attaching stale or missing video recordings — now the right video lands with each run. Small fix shipping ahead of 1.1.x.

---

## 1.0.7 — 2026-05-16

- **[Test Runner]** **Playwright traces in the heal index.** I started feeding the Playwright trace for each failure into the heal index, and the agent started fixing things noticeably faster — it can see exactly what happened in the browser instead of guessing from logs. Shipping this one quickly because it felt too useful to sit on
- **[General]** **Various bug fixes.**

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

> The headline change: Canary Lab is now driven from a local web UI (`canary-lab ui`) instead of a stack of iTerm tabs. Run `npx canary-lab upgrade` after upgrading to refresh managed scaffold files.

- **[General]** **New web UI (`canary-lab ui`).** Boots a local Fastify server on `http://localhost:7421` and opens it in your default browser. Three-column Finder-style layout: features on the left, run history in the middle, live PTY logs and journal viewer on the right. Pass `--no-open` to suppress the auto-launch (useful over SSH or in CI), `--port <n>` to bind a different port.
- **[General]** **Default workflow is now the web UI, not iTerm tabs.** The Quick Start in the README is `npm install && npm run install:browsers && npx canary-lab ui`. Test execution, envset edits, run review, and heal controls now live in the UI.
- **[General]** **macOS-only is no longer a hard constraint.** Services and the heal agent run inside `node-pty` pseudo-terminals owned by Canary Lab — no AppleScript, no iTerm, no Terminal.app. Linux support is now in reach (the runner itself is cross-platform; only auto-launching the browser falls back to `xdg-open` / `cmd start`).
- **[General]** **Coverage gate.** Business-logic modules are gated at ≥92% on all four metrics (statements, branches, functions, lines). Enforced in CI; no `/* v8 ignore */` pragmas anywhere — exclusions live at the config level.
- **[General]** **Legacy workflow commands removed.** `canary-lab run`, `canary-lab env`, and `canary-lab new-feature` are no longer public commands. Use `canary-lab ui` for runs, envsets, and feature configuration.
- **[General]** **iTerm / Terminal.app AppleScript launchers removed.** The `shared/launcher/iterm.ts` and `shared/launcher/terminal.ts` backends are gone, along with their AppleScript shims and tab-cleanup logic. Everything runs through `node-pty` now.
- **[Test Runner]** **Run history.** The last 20 runs are preserved under `logs/runs/<runId>/` — each with its own service logs, summary JSON, heal index, and `runner.log`. Older runs roll off automatically. You can browse, compare, and re-open them from the UI without re-running.
- **[Test Runner]** **Run-scoped diagnosis journal.** New heal iterations are written to `logs/runs/<runId>/diagnosis-journal.md`. Existing root-level journals are left in place as legacy history.
- **[Test Runner]** **`runner.log` per run.** The orchestrator now writes its own progress (lifecycle events, signal handling, restart decisions) to `logs/runs/<runId>/runner.log` — so you can audit what *the runner* did, separately from what each service or the agent did.
- **[Test Runner]** **Playwright Playback.** Run detail now has a structured playback view with final screenshots, trace downloads, inline retained video, collapsed browser actions, and the raw Playwright terminal as a fallback.
- **[Test Runner]** **`.playwright-mcp` artifact capture.** When Playwright's MCP integration emits artifacts during a failure, they're collected into the per-failure folder under `logs/failed/<slug>/.playwright-mcp/` so the heal agent can find them next to the sliced service logs.
- **[Test Runner]** **Readline-prompted "Auto-heal on test failure?" flow removed.** The old terminal prompt is gone. Heal mode is selected and controlled from the web UI.
- **[Test Generation]** **Add Test wizard.** A guided flow inside the UI: PRD draft → skill recommender → plan → spec generation. The wizard streams Claude / Codex output live and lands a ready-to-run Playwright spec into the chosen feature.

### Breaking changes

- **[Test Runner]** **`logs/` layout changed.** Per-run artifacts now live under `logs/runs/<runId>/` rather than at the top of `logs/`. Symlinks at `logs/svc-*.log` etc. point at the latest run for backward-compat with skill files, but anything reading absolute paths under `logs/` will need to follow the new structure.
- **[General]** **iTerm-tab-based scripts are gone.** If you had wrapper scripts that grepped iTerm window titles or relied on AppleScript-driven cleanup, they will no longer find anything to act on.
