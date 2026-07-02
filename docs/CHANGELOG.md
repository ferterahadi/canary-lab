# Changelog

All notable changes to Canary Lab are listed here. We try to keep the language plain so anyone can follow along.
---
Each entry is tagged with the area it touches:

- **[Test Runner]** — running tests, run history, auto-heal, services, logs
- **[Test Generation]** — Add Test wizard, PRD/plan/spec drafting
- **[Coverage]** — verified coverage ledger, requirement-to-test traceability
- **[Export evaluation]** — exported evaluation reports
- **[Portify]** — port-ification wizard, converting features to dynamic port allocation
- **[Cleanup]** — log and run history cleanup
- **[Benchmark]** — measuring how the repair loop performs compared to running tests without Canary Lab
- **[General]** — UI shell, CLI, scaffolding, packaging

---

## Unreleased

- **[General]** **First Flight — `npx canary-lab fly <repo...> "<what to test>"`.** One command takes a bare product repo to a green, covered, healed run that ends in an evaluation archive. A server-side conductor chains the existing stages — repo scout (an agent drafts `feature.config.cjs` and detects env files), scaffold, env capture proven by a dry-run boot, docs/PRD (drop a doc or infer from repo docs / diff vs base branch), a specs↔coverage loop to the coverage target, portify, run + auto-heal, evaluation export — and canary computes every stage verdict; the agent only proposes.
  - Typed, resumable checkpoints: config approval, PRD source, portify apply, non-green run (rerun vs export-as-is), and missing env secrets (never skipped, even with `--yolo`). A crash or failed stage pauses the flight; the next `fly` resumes from the first open stage (`--fresh` starts over).
  - Re-entry safe: a repo that already has a feature parks on a rerun / enhance / new choice — never a silent duplicate. `fly` also creates the workspace and boots the server when needed.
  - New **Flights** pill in the top bar (live active count) and a routed flight view (`?view=flights&flight=<id>`) with a per-stage rail, harness evidence, checkpoint controls, and the stage agent's live timeline.
  - MCP parity: `start_flight` / `get_flight` / `respond_flight_checkpoint` (author/lifecycle/full profiles) drive the same flight store; external clients can feed conversation-distilled docs via `write_feature_doc` before the PRD stage.

---

## 1.5.1 — 2026-07-03

- **[Test Runner]** Small run-detail UI update: journal updates refresh while a run is open, and the heal-agent terminal stays visible during active auto-heal cycles.

---

## 1.5.0 — 2026-07-01

> Node 20.19+ (or 22.12+) is now required — see Breaking changes.

- **[Test Runner]** **Test-file integrity tracking.** Canary Lab now tracks each spec's actual content, not just whether Playwright ran it, so edits made mid-heal, by a teammate, or by accident are flagged instead of silently standing.
  - Only the touched test(s) turn red, with the code view highlighting changed lines since the last commit.
  - A "Tests modified" pill + review panel list affected features; **Commit changes** stages/commits just those specs (an external `git commit` also clears the flag).
  - Green baseline is bound to the pre-heal spec version, so a test edited to force a pass isn't accepted as the new normal.
  - Updates live, no refresh; review panel can open the workspace in your editor.
- **[Test Runner]** MCP-connected agents (Claude, Codex, etc.) now get a modified-tests warning on run results instead of treating them as fully trustworthy.
- **[General]** Feature/run/evaluation-export lists to MCP clients now use TOON instead of per-row field names — fewer tokens, same data.
- **[General]** Fixed: the version-update button could fail instead of installing the new version.

### Breaking changes

- **[General]** **Minimum Node version raised to 20.19 (or 22.12+).** Needed for the smaller agent responses above. If you're on an older Node 20.x, upgrade before running `npx canary-lab`.

---

## 1.4.x — 2026-06-26 to 2026-06-30

- **[Coverage]** **New: the Verified Coverage Ledger.** Maps every PRD requirement to the tests that exercise it, via the new coverage pill on any feature.
  - Percentage is **computed, not guessed**: a requirement counts as covered only when every declared path/variant has a mapped test.
  - Mapping is **inline and reviewable**: background agents read the PRD and specs and write `@req-<id>` tags into the tests themselves; runs non-blocking, survives switching away/refreshing.
  - Breaks down **by variant and path** with a strength filter and breakdown ring; coverage/tags can be reset to start fresh.
- **[Test Runner]** **Stop & heal after 2 failures by default.** Playwright stops at 2 failures and the repair loop kicks in — enough signal for the healing agent without choking on a full-suite log. Toggle off per feature in General config to run the full suite first.
- **[Test Runner]** **Log-size awareness.** The failure index shows each log slice's size, and flags + links to the full log on disk when a slice was trimmed, instead of leaving the agent to infer from a silently-clipped excerpt.
- **[Test Runner]** **CLI heal claiming restored.** Any interactive Claude/Codex session (Desktop *or* CLI) can claim a heal loop again; only Canary Lab's own benchmark/Portify agents stay blocked, since they must never claim the run they're working on.
- **[Test Runner]** **Better failure guidance.** Boot failures now come with what-to-try-next instead of raw logs; stuck repair loops get detected and escalated with extra context (re-running, `node_modules` handling); external clients without the skill installed get explicit next-step instructions in heal context.
- **[Portify]** **Un-portify.** Reverse a port-ification — original config restored, overlay removed.
- **[Portify]** **Steadier wizard.** Proper concurrency limits, graceful handling of missing/orphaned workflow records, simplified picker (redundant history list removed).
- **[General]** **`init` gets you running in one step.** `npx canary-lab init <folder>` installs deps, browsers, and registers agent tools; `--no-install` to scaffold only.
- **[General]** **Reliable agent launch under restricted PATH.** `claude`/`codex` resolution now checks all usual install locations and respects `CANARY_LAB_CLAUDE_BIN`/`CANARY_LAB_CODEX_BIN` overrides.
- **[General]** **Version indicator with one-click update.** Sits in the Features-column footer; checks the npm registry, and lets you install (`npm install canary-lab@latest`) and restart from there; quiet when current, never blocks startup if the registry is unreachable.
- **[General]** **Live updates everywhere.** Verification-config, coverage, and feature changes push to every open browser in real time.
- **[General]** **Clearer external-client panels.** Connected-client agent panels share one card with consistent branding.
- **[General]** **Custom CLI config dirs respected.** Session logs are read from `CLAUDE_CONFIG_DIR`/`CODEX_HOME` when relocated, with the interactive shell probed at boot to pick up rc-file-only vars — fixes a silently-blank agent view.

---

## 1.3.x — 2026-06-14 – 2026-06-16

> MCP server is renamed to `Canary_Lab` — run `npx canary-lab setup --force` and restart your agent after upgrading.

- **[Portify]** **Run a feature that was never built for concurrency.** If a feature has hardcoded ports, it'll collide with anything else running at the same time. The port-ification wizard fixes that: an agent rewrites the ports to dynamic allocation, you review and revise, and the change lands as a reversible overlay before anything is committed.
- **[Cleanup]** **Reclaim disk space without leaving the UI.** Old run logs pile up fast. A new cleanup panel lets you see what's there, filter to boot sessions, and remove what you no longer need — no file manager required.
- **[Benchmark]** **Groundwork for pluggable harnesses** *(preview — enable with `?showBenchmark=true`).* Runs the same tests with and without Canary Lab and puts the outcomes side by side.
- **[Test Runner]** **Know which services came up without reading the logs.** Boot-only runs now show a readiness result per service the moment startup finishes — pass, fail, or timeout at a glance.
- **[Test Runner]** **The healing agent sees the whole picture.** Failure evidence is no longer clipped — the agent always gets the full content, or a clear pointer to the file on disk. Repetitive log lines (retry loops, health-check polls) are collapsed into a count and range so the agent gets to the real signal faster.
- **[General]** **MCP health badge and connect guide.** The UI shows whether your agent is connected, with a guide for linking Claude Desktop, Codex, or other clients.
- **[General]** **Heal claims limited to Desktop clients.** CLI-connected agents can read run state and failure evidence but can no longer claim heals.
- **[General]** **Port changes no longer break your agent session.** The MCP bridge watches the live server record and reconnects automatically.
- **[General]** **Lighter install and fuller getting-started guide.**

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

## 1.0.x — 2026-04-30 – 2026-05-17

> The headline change in 1.0.0: Canary Lab is now driven from a local web UI (`canary-lab ui`) instead of a stack of iTerm tabs. Run `npx canary-lab upgrade` after upgrading to refresh managed scaffold files.
>
> 1.0.1 changed the heal signal body — re-run `npx canary-lab upgrade` to refresh the managed `CLAUDE.md` / `AGENTS.md` heal block (see Breaking changes).

- **[General]** **New web UI (`canary-lab ui`).** Boots a local Fastify server on `http://localhost:7421` and opens it in your default browser. Three-column Finder-style layout: features on the left, run history in the middle, live PTY logs and journal viewer on the right. Pass `--no-open` to suppress the auto-launch, `--port <n>` to bind a different port.
- **[General]** **macOS-only is no longer a hard constraint.** Everything runs through `node-pty` — no AppleScript, no iTerm, no Terminal.app. Linux support is now in reach.
- **[General]** **Legacy workflow commands removed.** `canary-lab run`, `canary-lab env`, and `canary-lab new-feature` are gone. Use `canary-lab ui`.
- **[General]** **Fresh look.** The interface was redesigned with cleaner styling, clearer run status indicators, and a friendlier global status bar.
- **[Test Runner]** **Run history.** The last 20 runs are preserved under `logs/runs/<runId>/` with service logs, summary JSON, heal index, and `runner.log`. Browse and re-open them from the UI without re-running.
- **[Test Runner]** **Playwright Playback.** Run detail has a structured playback view with screenshots, trace downloads, inline video, collapsed browser actions, and raw terminal fallback.
- **[Test Runner]** **Playwright traces in the heal index.** Each failure's trace is fed to the heal agent so it can see exactly what happened in the browser instead of guessing from logs.
- **[Test Runner]** **Heal cycles show a real diff.** Canary Lab snapshots the repo before each attempt and records exactly what the agent changed, shown as a diff block in the diagnosis journal.
- **[Test Runner]** **More reliable self-heal cycle.** The auto-heal loop is steadier across iterations — long runs no longer get cut off, the agent resumes the same conversation across steps, and context (PRD, docs, skills) is carried into each heal attempt.
- **[Test Runner]** **Better test discovery and run status.** Tests defined through helpers are picked up correctly; run state tracking is more accurate; lifecycle timeline per run.
- **[Test Runner]** **Live agent activity view.** The agent session screen streams what's happening in real time.
- **[Test Generation]** **Add Test wizard.** A guided flow inside the UI: PRD draft → plan → spec generation. Wizard task tracker shows which drafts are in progress and lets you pick up where you left off.
- **[Export evaluation]** **Plain-English evaluation report.** Exported reports go through a rewrite pass that turns code-like identifiers into clear descriptions. Fixed a case where stale/missing video recordings were attached to exported runs.

### Breaking changes

- **[Test Runner]** **Heal signal payload changed** *(1.0.1).* The `.restart` / `.rerun` body is now `{"hypothesis":"…","fixDescription":"…"}` — `filesChanged` is gone. Custom prompts need to drop `filesChanged` and add `fixDescription`.
- **[Test Runner]** **`logs/` layout changed** *(1.0.0).* Per-run artifacts now live under `logs/runs/<runId>/`. Symlinks at `logs/svc-*.log` cover the latest run for backward-compat, but absolute paths under `logs/` need to follow the new structure.
