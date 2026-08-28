# Changelog

All notable changes to Canary Lab are listed here. We try to keep the language plain so anyone can follow along.
---
Each entry is tagged with the area it touches:

- **[Test Runner]** — running tests, run history, auto-heal, services, logs
- **[Test Generation]** — spec authoring and PRD/plan drafting (the flight's authoring stage; the standalone Add Test wizard before it)
- **[Coverage]** — verified coverage ledger, requirement-to-test traceability
- **[Export evaluation]** — exported evaluation reports
- **[Portify]** — port-ification wizard, converting features to dynamic port allocation
- **[Cleanup]** — log and run history cleanup
- **[Benchmark]** — measuring how the repair loop performs compared to running tests without Canary Lab
- **[General]** — UI shell, CLI, scaffolding, packaging

---

## 2.1.0 — 2026-08-28

> Run `npx canary-lab upgrade`, then restart connected agent apps, to refresh Canary Lab skills and switch existing connections to the compact profile.

- **[General]** **Playwright tests now open in plain English.** The Test Ledger renders authored steps, actions, checks, helpers, branches, retries, and loops as a nested story derived locally without an LLM, with the original code one click away.
- **[Coverage]** **Coverage uses the same source-linked test story.** Selecting an English step opens its exact code and editor location—even inside a helper file—while unsupported syntax stays visible as source instead of being guessed.
- **[Coverage]** **Coverage passes focus on the gaps still open.** Flight validates each authored batch, asks the mapper only about requirements that remain uncovered, preserves every pass in Activity, and stores the exact coverage percentage for stable status updates.
- **[General]** **Reports arrive before Parallel setup.** Flight runs the tests, repairs failures, and creates the downloadable report first; Parallel setup then finishes independently and can be retried without deleting that evidence.
- **[General]** **Flight keeps the full agent-work timeline.** Activity separates every authoring and mapping session in order, retains earlier passes across reloads, and records work performed in an external Claude or Codex conversation.
- **[General]** **Agent connections now load one compact tool.** The default `exec` connection keeps every Canary Lab command available while reducing the tool context carried in normal agent conversations.

---

## 2.0.x — 2026-08-25

> **Upgrading from 1.5.x:** install Node 22.12+, run `npm install --save-dev canary-lab@2 && npx canary-lab upgrade`, then restart Canary Lab and connected agent apps.

- **[General]** **Flight is now the main workflow.** It guides a repo through seven steps: scan, setup, requirements, test authoring and coverage, parallel readiness, test run, and evaluation report.
  - Start from the UI by choosing repos and describing what to test, or run `npx canary-lab flight <repo...> "<what to test>"`.
  - Review the generated config, link requirement documents, and choose a fast or rewritten evaluation report.
  - Pause, resume, stop, or restart a Flight. Autopilot can answer routine checkpoints, while secrets and failed runs still require a decision.
  - A broad request can create several queued Flights. Features can also be grouped in the Flights list.
  - Repos and the test description stay fixed after a Flight starts. Delete the stopped Flight to begin again with different inputs.
- **[General]** **Flight replaces the standalone Add Test and Portify pages.** Test authoring and parallel setup now live inside Flight. The Flights view shows progress, evidence, checkpoints, agent activity, and run controls in one place.
- **[General]** **Agents can manage Flights through MCP.** Connected clients can start a Flight, read its state, answer checkpoints, and link local requirement documents.
- **[Test Runner]** **Repairs no longer edit your checkout.** Each run uses a temporary Git worktree. Canary Lab saves the repair as a patch under `logs/runs/<runId>/fixes/`, then removes the temporary copy. Portified runs keep the worktree so you can review it from Cleanup.
- **[Test Runner]** **Healing is safer when more than one Canary Lab process is open.** A second process no longer marks a live repair as aborted, and a repair stops cleanly if another process finishes the run.

### Breaking changes

- **[General]** **Node 22.12 or newer is required.** Older versions do not support a module feature Canary Lab needs and can fail at startup.

---

## 1.5.x — 2026-07-01 to 2026-07-03

> Node 20.19+ (or 22.12+) is now required — see Breaking changes.

- **[Test Runner]** **Canary Lab now detects changes to test files.** Edited tests are marked, their changed lines are shown, and they cannot silently replace the trusted version used before healing. You can review and commit only the affected tests.
- **[Test Runner]** **Connected agents are warned when tests changed.** Claude, Codex, and other clients no longer treat those run results as fully trusted.
- **[Test Runner]** **Open run details stay current.** Journal updates refresh automatically, and the healing-agent terminal remains visible during repairs.
- **[General]** **Agent responses use fewer tokens.** Feature, run, and evaluation lists are sent in a more compact format without removing data.
- **[General]** **The version update button works reliably.** It now installs the selected update instead of sometimes failing.

### Breaking changes

- **[General]** **Node 20.19+ or 22.12+ is required.** Upgrade older Node versions before running Canary Lab.

---

## 1.4.x — 2026-06-26 to 2026-06-30

- **[Coverage]** **The Verified Coverage Ledger maps requirements to tests.** Coverage is calculated from the paths and variants that have mapped tests, not guessed. Agents add reviewable requirement tags in the background, and you can reset the ledger when needed.
- **[Test Runner]** **Runs stop and start healing after two failures by default.** This gives the repair agent useful evidence without waiting for the full suite. You can disable the limit per feature.
- **[Test Runner]** **Failure evidence is clearer.** Canary Lab shows when a log was shortened, links to the full file, explains boot failures, and gives better guidance when a repair gets stuck.
- **[Test Runner]** **Interactive Claude and Codex sessions can claim repairs.** This works from Desktop and CLI clients. Canary Lab's own Benchmark and Portify agents remain blocked from claiming their own runs.
- **[Portify]** **Portify is reversible and more reliable.** You can restore the original config, while improved limits and recovery prevent duplicate or abandoned workflows.
- **[General]** **`npx canary-lab init <folder>` completes setup in one command.** It installs dependencies and browsers, then registers agent tools. Use `--no-install` to create files only.
- **[General]** **Claude and Codex launch more reliably.** Canary Lab checks common install locations and supports `CANARY_LAB_CLAUDE_BIN` and `CANARY_LAB_CODEX_BIN` overrides.
- **[General]** **Updates are easier to see and install.** The UI shows when a newer version exists and can install it without blocking startup if npm is unavailable.
- **[General]** **Open browsers stay in sync.** Changes to verification settings, coverage, and features appear without a refresh.
- **[General]** **Custom agent config folders now work.** Canary Lab respects `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, preventing blank agent-session views when logs live outside the default folder.
- **[General]** **Connected-agent panels are simpler.** Related status and controls now share one consistent panel.

---

## 1.3.x — 2026-06-14 to 2026-06-16

> MCP server is renamed to `Canary_Lab` — run `npx canary-lab setup --force` and restart your agent after upgrading.

- **[Portify]** **Portify prepares features for parallel runs.** An agent replaces fixed ports with dynamic ones, and you review the changes before they are applied.
- **[Cleanup]** **Run logs can be removed from the UI.** The Cleanup page shows stored runs and boot sessions so you can reclaim disk space.
- **[Benchmark]** **Preview: compare tests with and without Canary Lab.** Enable `?showBenchmark=true` to view both results side by side.
- **[Test Runner]** **Boot checks show each service result.** You can see which services passed, failed, or timed out without reading raw logs.
- **[Test Runner]** **Repair agents receive complete failure evidence.** Large logs link to the full file, while repeated lines are condensed so the useful details remain visible.
- **[General]** **Agent connections are easier to set up and monitor.** The UI adds a connection guide and health badge, and reconnects automatically when the Canary Lab port changes.
- **[General]** **Only Desktop clients can claim repairs in this release.** CLI clients can still inspect runs and failure evidence.
- **[General]** **Installation is smaller and the getting-started guide is more complete.**

---

## 1.2.0 — 2026-06-01

> Run `npx canary-lab upgrade` to refresh your sample features so they pick up per-run ports for concurrent runs.

- **[Test Runner]** **Several test runs can run at the same time.** Runs start together when their ports do not conflict. Extra work waits in a queue, and a second run on a busy repo can wait or use an isolated copy.
- **[Test Runner]** **Services can start without running tests.** Boot-only mode lets you inspect the app, reproduce a problem, or confirm startup before launching the full suite.

---

## 1.1.0 — 2026-05-28

> Canary Lab can now be controlled from Codex, Claude, and other MCP clients. Run `npx canary-lab setup` after upgrading to refresh the connection.

- **[General]** **Connected agents can control Canary Lab.** They can start runs, inspect failures, and continue work from the chat.
- **[Test Runner]** **Agents can repair failed runs.** A connected agent can read saved evidence, change the app, and ask Canary Lab to rerun or restart.
- **[Test Generation]** **Agents can build test features.** They can create features, add notes, apply generated tests, and prepare evaluation exports.
- **[General]** **The UI is clearer and more stable.** Run, repair, verification, export, and status screens use simpler labels and steadier updates.

---

## 1.0.x — 2026-04-30 to 2026-05-17

> Canary Lab now runs from a local web UI with `canary-lab ui`. Run `npx canary-lab upgrade` after upgrading to refresh managed workspace files.
>
> Version 1.0.1 changed the repair signal format. Run `npx canary-lab upgrade` again to refresh the managed `CLAUDE.md` and `AGENTS.md` instructions.

- **[General]** **A local web UI replaces separate terminal tabs.** It shows features, run history, live logs, and repair notes in one window. Use `--no-open` to prevent automatic browser launch or `--port <n>` to choose a port.
- **[General]** **The old `run`, `env`, and `new-feature` commands are removed.** Use `canary-lab ui` instead.
- **[General]** **Canary Lab no longer depends on AppleScript or iTerm.** Terminal processes now run through `node-pty`, reducing macOS-specific setup.
- **[General]** **The interface has clearer status and navigation.** Features, runs, logs, and global status are easier to scan.
- **[Test Runner]** **The last 20 runs remain available.** Reopen saved logs, summaries, repair evidence, and results without running the tests again.
- **[Test Runner]** **Playwright results are easier to review.** Run details show screenshots, videos, browser actions, trace downloads, and raw terminal output.
- **[Test Runner]** **Repair agents receive browser traces and show their changes.** Each repair records a diff so you can see exactly what the agent edited.
- **[Test Runner]** **Automatic repair is more reliable.** Long runs keep their agent session and context, test discovery is more accurate, and the UI shows run progress and live agent activity.
- **[Test Generation]** **The Add Test wizard guides test creation.** It moves from a requirement draft to a plan and generated spec, while preserving unfinished work.
- **[Export evaluation]** **Evaluation reports use plain English.** Exported reports replace code-like names with readable descriptions and avoid attaching stale or missing videos.

### Breaking changes

- **[Test Runner]** **Repair signals changed in 1.0.1.** `.restart` and `.rerun` now use `{"hypothesis":"…","fixDescription":"…"}`. Custom prompts must remove `filesChanged` and add `fixDescription`.
- **[Test Runner]** **Run files moved in 1.0.0.** Each run now stores its files under `logs/runs/<runId>/`. Existing `logs/svc-*.log` links still point to the latest run, but custom absolute paths must be updated.
