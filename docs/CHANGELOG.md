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

## 1.4.2 — 2026-06-30

- **[Test Runner]** **Every feature stops and heals after 2 failures by default.** As soon as 2 tests fail, Playwright stops and the repair loop kicks in — no waiting for the whole suite. Two is the sweet spot for log size: enough signal for the healing agent to work from, few enough that it reads the failures in one pass instead of choking on too much context at once. To run the full suite first on a feature, set "Stop & heal after" to off in its General config.
- **[Test Runner]** **The healing agent knows how big each log is.** The failure index now shows each log slice's size up front and, when a slice was trimmed to fit, says so and points at the full log on disk — so the agent can read it in one go or grep into it for the part it needs, instead of working from a silently-clipped excerpt.
- **[General]** **Agent views work when your CLI config lives somewhere custom.** If you've relocated `claude` or `codex` config with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` (multi-account, sandboxed, or CI setups), Canary now reads session logs from the same place the CLI writes them — and probes your interactive shell at boot to pick up vars set only in your rc file. Fixes a silently-blank agent view that looked like "the agent produced nothing."

---

## 1.4.1 — 2026-06-27

- **[General]** **`init` gets you running in one step.** `npx canary-lab init <folder>` installs deps, browsers, and registers agent tools — go straight to `npx canary-lab ui`. Pass `--no-install` to scaffold only.
- **[General]** **Agents launch reliably under a restricted PATH.** When started by a desktop client, `claude`/`codex` could silently fail to resolve. Canary Lab now checks all the usual install locations and respects `CANARY_LAB_CLAUDE_BIN` / `CANARY_LAB_CODEX_BIN` overrides.
- **[General]** **Know when a new version is out — and update in one click.** A small version indicator now sits in the Features-column footer, next to the theme toggle. It checks the npm registry and shows whether you're up to date or a newer Canary Lab has been published. Click it for the details: when an update is available, install it right there (`npm install canary-lab@latest` runs in your workspace), then restart `canary-lab ui` to apply. It stays quiet when you're current, confirms your version on click, and never blocks startup if the registry can't be reached.

---

## 1.4.0 — 2026-06-26

- **[Coverage]** **New: the Verified Coverage Ledger.** Coverage answers a simple question — are your tests actually thorough? It maps every requirement in your PRD to the tests that exercise it, shows what's covered and what's missing, and points the agent at the gaps so it can add the test cases you don't have yet. Open it from the new coverage pill on any feature.
  - The percentage is **computed, not guessed**: a requirement only counts as covered when every declared path (and variant) has a mapped test — math from your tags, not an agent judging it "looks covered."
  - The mapping is **inline and reviewable**: generating a ledger runs background agents that read your PRD and specs, then write `@req-<id>` tags into the tests themselves. It runs without blocking you, and survives switching away or refreshing.
  - Coverage breaks down **by variant and path**, so a half-covered requirement shows exactly which case is missing. A strength filter and breakdown ring tell a thoroughly-tested requirement from a barely-touched one, and you can reset coverage or strip the tags to start fresh.
- **[Portify]** **Un-portify a feature.** Changed your mind? You can now reverse a port-ification — the original config is restored and the overlay is removed, cleanly.
- **[Portify]** **Steadier port-ification.** The wizard now runs with proper concurrency limits, handles missing or orphaned workflow records gracefully instead of getting stuck, and the picker is simpler — the redundant history list is gone.
- **[Test Runner]** **Healing from the CLI is back.** Heal claiming is no longer limited to Desktop clients — any interactive Claude or Codex session (Desktop *or* CLI) can own a heal loop again. The only sessions still blocked are the ones Canary Lab spawns itself for benchmarks and Portify, which must never claim the very run they're working on.
- **[Test Runner]** **Healing when services won't boot.** If an app's services fail to start, the agent now gets the boot failure spelled out with what to try next, instead of being left to infer it from raw logs.
- **[Test Runner]** **Breaking out of stuck loops.** When the repair loop stops making progress, Canary Lab now detects the stuck cycle and escalates with extra context — including clearer guidance on re-running and on handling `node_modules` — rather than churning on the same failed approach.
- **[Test Runner]** **Better handoff for agents without the skill installed.** External clients that don't have the Canary Lab skill loaded now get explicit next-step instructions in the heal context, so they can still drive a repair correctly.
- **[General]** **Live updates everywhere.** Verification-config edits, coverage changes, and feature changes now push to every open browser in real time — no more refreshing to see what another client (or a background job) just did.
- **[General]** **Clearer external-client panels.** Agent panels for connected clients now share a single card with consistent branding, so it's easier to see which client is doing what.

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
