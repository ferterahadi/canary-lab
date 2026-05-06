# Changelog

All notable changes to Canary Lab are listed here. We try to keep the language plain so anyone can follow along.

## 1.0.0 — 2026-04-30

> The headline change: Canary Lab is now driven from a local web UI (`canary-lab ui`) instead of a stack of iTerm tabs. Run `npx canary-lab upgrade` after upgrading to refresh the managed `CLAUDE.md` / `AGENTS.md` blocks.

### Added

- **New web UI (`canary-lab ui`).** Boots a local Fastify server on `http://localhost:7421` and opens it in your default browser. Three-column Finder-style layout: features on the left, run history in the middle, live PTY logs and journal viewer on the right. Pass `--no-open` to suppress the auto-launch (useful over SSH or in CI), `--port <n>` to bind a different port.
- **Run history.** The last 20 runs are preserved under `logs/runs/<runId>/` — each with its own service logs, summary JSON, heal index, and `runner.log`. Older runs roll off automatically. You can browse, compare, and re-open them from the UI without re-running.
- **Run-scoped diagnosis journal.** New heal iterations are written to `logs/runs/<runId>/diagnosis-journal.md`, with `logs/current/diagnosis-journal.md` as the manual-agent path for the active run. Existing root-level journals are left in place as legacy history.
- **`runner.log` per run.** The orchestrator now writes its own progress (lifecycle events, signal handling, restart decisions) to `logs/runs/<runId>/runner.log` — so you can audit what *the runner* did, separately from what each service or the agent did.
- **Add Test wizard.** A guided flow inside the UI: PRD draft → skill recommender → plan → spec generation. The wizard streams Claude / Codex output live and lands a ready-to-run Playwright spec into the chosen feature.
- **Playwright Playback.** Run detail now has a structured playback view with final screenshots, trace downloads, inline retained video, collapsed browser actions, and the raw Playwright terminal as a fallback.
- **`.playwright-mcp` artifact capture.** When Playwright's MCP integration emits artifacts during a failure, they're collected into the per-failure folder under `logs/failed/<slug>/.playwright-mcp/` so the heal agent can find them next to the sliced service logs.
- **Coverage gate.** Business-logic modules are gated at ≥92% on all four metrics (statements, branches, functions, lines). Enforced in CI; no `/* v8 ignore */` pragmas anywhere — exclusions live at the config level.

### Changed

- **Default workflow is now the web UI, not iTerm tabs.** The Quick Start in the README is `npm install && npm run install:browsers && npx canary-lab ui`. Test execution, envset edits, run review, and heal controls now live in the UI.
- **macOS-only is no longer a hard constraint.** Services and the heal agent run inside `node-pty` pseudo-terminals owned by Canary Lab — no AppleScript, no iTerm, no Terminal.app. Linux support is now in reach (the runner itself is cross-platform; only auto-launching the browser falls back to `xdg-open` / `cmd start`).

### Removed

- **Legacy workflow commands.** `canary-lab run`, `canary-lab env`, and `canary-lab new-feature` are no longer public commands. Use `canary-lab ui` for runs, envsets, and feature configuration.
- **iTerm / Terminal.app AppleScript launchers.** The `shared/launcher/iterm.ts` and `shared/launcher/terminal.ts` backends are gone, along with their AppleScript shims and tab-cleanup logic. Everything runs through `node-pty` now.
- **Readline-prompted "Auto-heal on test failure?" flow.** The old terminal prompt is gone. Heal mode is selected and controlled from the web UI.

### Breaking changes

- **`logs/` layout changed.** Per-run artifacts now live under `logs/runs/<runId>/` rather than at the top of `logs/`. Symlinks at `logs/svc-*.log` etc. point at the latest run for backward-compat with skill files, but anything reading absolute paths under `logs/` will need to follow the new structure.
- **iTerm-tab-based scripts are gone.** If you had wrapper scripts that grepped iTerm window titles or relied on AppleScript-driven cleanup, they will no longer find anything to act on.

## 0.9.4 — 2026-04-27

### Added

- **New skill so Claude knows where tests go.** Run `npx canary-lab upgrade` to pick it up. When you ask Claude to add a Playwright test in a canary-lab project, it now reads a built-in guide that explains the feature folder layout, the right imports, and where files belong — instead of guessing and putting things in the wrong place.

## 0.9.3 — 2026-04-27

> Pure speed-up release. No new commands, no changes to how you use Canary Lab. Just less waiting between runs.

### Changed

- **Tests run faster overall.** The runner used to do bookkeeping work after every single test (extracting log slices, rebuilding the heal map) — even when nothing failed. Now it only does that work when there's actually a failure to heal, and skips the duplicate pass at the end of the run.
- **Service startup is parallel, not one-at-a-time.** When your project has multiple services (say an API, a worker, and a frontend), the runner now waits on all their health checks at the same time instead of in sequence. If each service takes ~5 seconds to warm up, you save ~10 seconds per run on a 3-service setup.
- **Less file thrash inside `logs/`.** Each service log is now read once per run no matter how many tests failed (used to be re-read per failure). The iTerm session-id cache file no longer rewrites itself when nothing changed.

### Removed

- **Dead `logs/pids/` code path.** Old code wrote `.pid` files for each service so restarts could find them. Nothing has actually written those files in a long time — the runner already locates services by checking which port they're listening on. We deleted the leftover reader code and the `logs/pids/` directory it created. No behaviour change; just less to read when you're poking around the codebase.

### Benchmark note

- Wall-time savings depend heavily on your project shape. Single-service projects with no failures save ~half a second per cycle. Multi-service projects with several failures can save several seconds per cycle, mostly from the parallel health checks.

## 0.9.2 — 2026-04-25

> Run `npx canary-lab upgrade` inside existing projects to refresh the managed `CLAUDE.md` / `AGENTS.md` heal prompt.

### Fixed

- **Cleaner heal index.** Failure messages in `logs/heal-index.md` no longer include terminal color codes like `[2m` or `[31m]`. The index keeps the simple list format that worked well for the heal agent, just without the visual noise.

### Benchmark note

- The cleaned-up heal index gives the agent a clearer starting point during benchmarked self-heal runs. This does not add a new workflow; it simply removes noise from the same failure map the agent already reads first.

## 0.9.0 — 2026-04-24

> Run `npx canary-lab upgrade` to apply the managed-file changes (CLAUDE.md / AGENTS.md refresh and deprecated skill-file cleanup). Per-feature directories are user-owned, so their new shape — described under [Feature layout](#feature-layout) below — does not auto-apply.

### Added

- **Selective service restart on heal.** When the heal agent writes `logs/.restart` with a `filesChanged` list, the runner now restarts only the services whose repo actually owns one of those files — untouched services keep running, which is faster and keeps their logs intact. If `filesChanged` is missing or a path falls outside every known repo (e.g. a shared package or test file), the runner warns and falls back to restarting everything, so behaviour stays safe when impact is unclear.

### Changed

- **Heal workflow moved into `CLAUDE.md` / `AGENTS.md`.** The merged Self-Heal Workflow now lives between `<!-- heal-prompt:start -->` and `<!-- heal-prompt:end -->` markers inside the managed block. Both the manual `self heal` flow and the auto-heal runner read from the same source — one workflow, one source of truth.
- **`auto-heal` runner reads from `CLAUDE.md` / `AGENTS.md`** (claude / codex respectively) and extracts the heal-prompt section as its prompt.
- **Per-feature `src/config.ts` removed.** Features now load `.env` directly from `playwright.config.ts` and read `process.env.GATEWAY_URL` (with an inline default) in helpers. One fewer layer of indirection for scaffold readers to follow.

### Fixed

- **Service startup failure no longer kills everything.** When a service fails its health check, the runner now asks what you want to do: stop, self-heal manually, or hand it to Claude or Codex. Services and env files stay in place while you decide, so you can actually look at the logs.

### Removed

- `.claude/skills/heal-loop.md`, `.claude/skills/self-fixing-loop.md`, `.codex/heal-loop.md`, `.codex/self-fixing-loop.md` — content consolidated into `CLAUDE.md` / `AGENTS.md`. `canary-lab upgrade` removes these files from existing installs.
- `features/<name>/src/config.ts` (and the empty `src/` dir) in all scaffolded features.
- `features/<name>/.env.example` in all scaffolded features. The same values already live in `envsets/local/<name>.env`.

### Feature layout

The per-feature boilerplate is smaller in 0.9.0. The new shape of a scaffolded `features/<name>/` directory:

- `playwright.config.ts` loads the feature's `.env` directly:

  ```ts
  import path from 'node:path'
  import { config as loadDotenv } from 'dotenv'
  import { defineConfig } from '@playwright/test'
  import { baseConfig } from 'canary-lab/feature-support/playwright-base'

  loadDotenv({ path: path.join(__dirname, '.env') })

  export default defineConfig({ ...baseConfig })
  ```

- Helpers under `e2e/helpers/*.ts` read env values inline instead of importing a typed constant:

  ```diff
  -import { GATEWAY_URL } from '../../src/config'
  -
  -export class Api {
  -  baseUrl = GATEWAY_URL
  -}
  +export class Api {
  +  baseUrl = process.env.GATEWAY_URL ?? 'http://localhost:4000'
  +}
  ```

- `src/config.ts` and the `src/` directory are no longer part of the scaffold.

Projects scaffolded by 0.8.x keep the old shape — the shift is descriptive, not enforced by `canary-lab upgrade`.

## 0.8.0 — 2026-04-22

> Run `npx canary-lab upgrade` to pick up the new scaffolded skills and `CLAUDE.md` / `AGENTS.md` blocks.

### Added

- `logs/heal-index.md` — a markdown index the heal agent reads first. Lists each failure, its log-snippet paths, the failing line of the test with surrounding code, and a summary of the last 3 diagnosis-journal iterations.
- Per-failure log snippets at `logs/failed/<test>/<service>.log`, size-capped with head + tail.

### Changed

- `logs/e2e-summary.json` no longer embeds log excerpts; it points at the per-failure snippet files.
- Heal-loop skills (`.claude/skills/heal-loop.md`, `.codex/heal-loop.md`) read `logs/heal-index.md` first and open snippets on demand.
- Index and snippet files are written as tests complete, so a mid-run Ctrl+C still leaves the heal agent with fresh inputs.
- UI improvements across the runner and heal-agent tab: section headers, colored actions and paths, summary box, and ✓ / ✗ status at exit.

### Fixed

- `logs/e2e-summary.json` no longer exceeds Claude's file-read limit on large runs.

---

## 0.7.0 — 2026-04-19

Small, targeted improvements to the auto-heal loop.

> **How to apply this release to an existing project:** run `npx canary-lab upgrade` inside your project. A plain `npm install` / `npm update` won't refresh the scaffolded files (skills, `CLAUDE.md` / `AGENTS.md` blocks) — the upgrade command is what actually copies the new templates into your project.

### Improvements

- **Heal-agent tab reuses its iTerm tab between cycles.** Instead of closing and reopening, Canary Lab interrupts the previous run and reuses the same tab. Your scrollback stays intact.
- **Banner in the heal-agent tab** makes it clear that model and reasoning settings come from your own Claude / Codex CLI profile — Canary Lab doesn't override them.
- **Cleaner per-run service logs.** Each `logs/svc-*.log` is cleared at the start of every run, so it only contains the current iteration's output.
- **Codex heal output is easier to follow.** Common shell commands (`sed`, `cat`, `rg`, `grep`, `ls`, `find`) now render the same way as Claude's output instead of raw shell lines.
- **More reliable iTerm tab cleanup.** Canary Lab can still find and close heal-agent and service tabs after their titles change. Empty iTerm windows are closed automatically.
- **Faster, cheaper heal cycles.** The instructions the heal agent reads are now shorter and split into a short always-on prompt plus a fallback reference, so the common case uses fewer tokens and finishes faster. The agent is also explicitly told to fix the app, not the test, and to skip cleanly when there's nothing to heal.

### Fixes

- Scaffolded projects now get their `.gitignore` correctly — previously it was being stripped from the published package.

---

## 0.6.0 — 2026-04-17

The big theme: **when a test fails, you get help automatically**.

### What's new

- **Auto-heal mode.** When a test fails, Canary Lab can spawn a Claude or Codex agent that reads the failure, edits your code, and re-runs the test — all on its own. You can still drive it by hand if you prefer; both paths now live side by side.
- **A fallback for when the agent gives up.** If the auto-healer strikes out after three tries, the runner prints clear next steps (re-run, reset strikes, or take over interactively) instead of leaving you stuck.
- **Readable agent output.** Agents normally emit a firehose of raw JSON. We now translate that into a clean, human-readable progress stream for both Claude and Codex, so you can actually follow along.
- **New `heal-loop` guide.** Projects created with `canary-lab init` now ship with a `heal-loop` skill for Claude Code and Codex, so the agent knows exactly how to help when tests break — no setup on your side.
- **New sample: `tricky_checkout_api`.** A more realistic practice feature than the to-do list — a small checkout API with its own test server, example tests, and environment files. Great for trying the auto-healer on something that feels like real work.

### Improvements

- **More reliable terminal launchers.** Opening service tabs in iTerm and the macOS Terminal is smoother; fewer cases where a tab opens but nothing runs in it.
- **Clearer runner output.** The test runner now shows what phase you're in (starting services, running tests, healing) instead of mixing everything together.
- **Tidier new projects.** `canary-lab init` and `canary-lab upgrade` give projects a cleaner starting state — better `.gitignore`, refreshed `CLAUDE.md` / `AGENTS.md`, no leftover files from earlier drafts.
- **Smaller npm package.** Added an `.npmignore` so the published package contains only what's needed. Faster installs, less clutter.
- **Rewritten README.** Now includes an accurate component diagram of what runs during a test, so it's clear where the orchestrator, the launcher, the Playwright hooks, and the auto-healer each fit in.

### Housekeeping

- Removed four old skill files from the repo's internal `.claude/skills/` folder. Their guidance has been folded into the new skill setup.

---

## 0.5.1 — 2026-04-10

### Improvements

- **Clearer self-fixing docs.** The self-fixing loop guide now explains how to use logging effectively, so when something goes wrong you (and the agent) have better clues to work with.

### Housekeeping

- Removed the unused `broken_todo_api` and `example_todo_api` sample features from earlier drafts, trimming the repo.
- Version bump to 0.5.1.
