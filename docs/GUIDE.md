# Canary Lab Guide

Operator and reference detail for Canary Lab. For the overview, quick start, and core workflow, see the [README](../README.md).

## Environment Switching

Envsets are temporary environment files for a feature. During a run, Canary Lab backs up the target files, applies the selected envset, and restores the originals when the run ends. Manage them from the Envsets tab; they live under `features/<feature>/envsets/`.

Feature configs can make service startup env-specific — for example, a `local` env starts services while a `production` env skips local startup and points tests at a deployed URL.

### Testing Against a Remote URL

To run a feature's tests against a deployed environment without booting the local server:

1. Add the env to `feature.config.cjs` → `envs: ['local', 'production']`.
2. Gate each `startCommand` (or whole `repo`) with `envs: ['local']` so it only boots locally.
3. Add a matching envset under `envsets/<env>/<feature>.env` with the remote target — e.g. `GATEWAY_URL=https://api.example.com`. Tests read this via `process.env.GATEWAY_URL` (see `e2e/helpers/api.ts`).
4. Pick the env from the env dropdown in the web UI (`canary-lab ui`). The run flow applies/reverts the envset and skips booting filtered services.

### Environment Variable Safety

Envset files often contain credentials copied from local app configs. The default `.gitignore` ignores `features/*/envsets/*/*` so value files are not committed by accident. If you override this or use `git add -f`, review the files before pushing.

## Run Output

Each run writes to `logs/runs/<runId>/`:

- `manifest.json` — run metadata, services, repo snapshots, artifact policy, and signal paths
- `runner.log`, `lifecycle-events.jsonl` — orchestration events and UI lifecycle events
- `svc-*.log`, `playwright.log` — service stdout/stderr and raw Playwright output
- `playwright-events.jsonl` — structured test and browser-action events
- `playwright-artifacts/` — retained screenshots, videos, traces, and attachments
- `e2e-summary.json` — current test state and failure context
- `failed/<slug>/` — per-failure context slices
- `heal-index.md` — compact failure index for repair
- `diagnosis-journal.md` — heal-cycle notes and outcomes
- `signals/` — `.heal`, `.rerun`, and `.restart`

`logs/runs/index.json` tracks run history. Run detail pages and MCP flows resolve artifacts by run id.

## Evaluation Report

Completed runs can export an Evaluation Report from the run detail Overview tab — a `.zip` containing `evaluation.html` and captured videos. It summarizes what was tested, the result, and the evidence; each test case expands to show its flowchart, test code, helper code, videos, and checks.

![Evaluation Report sample](assets/assertion-review.png)

## Requirement Coverage

Open the **Coverage** view (the 🎯 pill in the top bar) to see which of a feature's PRD requirements have tests mapped — every requirement × path (× variant) cell, not just a test count. Requirements on the left, tests on the right, synced colour highlighting, and a coverage % canary computes from the tags rather than an agent's guess. Gap badges (Untested, Path-incomplete, Variant-incomplete) filter the view; a **strictness** badge grades how deep each test checks — app log → internal state → app API → real browser effect — and suggests a stronger assertion where achievable. The Docs tab holds the PRD's source material, with a "Regenerate" action that preserves requirement ids. See [FEATURES](FEATURES.md#requirement-coverage) for annotating tests and [COMMANDS](COMMANDS.md#requirement-coverage-mcp-authorlifecyclefull-profiles) for the MCP tools.

## Repairing a Failed Run

When a run fails, Canary Lab pauses it and waits for a fix, then reruns from the same run. Every fix ends in a `rerun` (test or config-only changes) or `restart` (service or app changes) signal. Two modes drive the fix:

### External heal (default)

An external MCP client (Claude or Codex CLI, or Claude Desktop) claims the failed run, fetches run-scoped context, fixes the app or test, and signals the next action. The orchestrator parks at `waiting-for-signal` and does not spawn its own agent. The loop is `claim_heal` → `get_heal_context` → `wait_for_heal_task` → edit code → `signal_run`.

Prefer the compact `get_heal_context` and `wait_for_heal_task` over polling; use `get_run_snapshot` only when you need verbose summaries or deeper debugging fields. If an agent session reports the Canary Lab tools are unavailable, run `npx canary-lab setup --force` and start a fresh session — MCP tools are discovered per client session, and the local HTTP API is only a fallback for custom clients.

### Auto-heal

Select **Claude** or **Codex** in Settings and Canary Lab starts that local CLI in a PTY tab when a run fails, rendering `apps/web-server/prompts/heal-agent.md` with the active run paths. Auto-heal stops when tests pass, the user stops the run, the agent exits without a useful signal, a cycle times out, or no supported CLI is available.

### Signal files

`.rerun` and `.restart` under `logs/runs/<runId>/signals/` are the low-level mechanism both modes use. You can write them by hand (or via the UI controls) to drive a fix from a custom client or while debugging. Legacy `manual` and `auto` project settings now migrate to external heal.

## First Flight (`canary-lab fly`)

The one-command onboarding pipeline: `npx canary-lab fly <repo...> "<what to test>"` conducts a bare product repo through every stage — similarity check, repo scout (an agent drafts `feature.config.cjs` + detects env files), scaffold, env capture (proven by a single dry-run boot), docs/PRD (drop a doc, or it's inferred from repo docs / the diff vs your base branch / the description), a specs↔coverage loop that authors tagged Playwright specs until the ledger hits the target (default 100%), portify (always — the double-boot verify earns the concurrency-ready mark), the run with auto-heal, and finally the evaluation export. The archive is the flight's deliverable; a stage never succeeds on the agent's say-so — canary computes every verdict (config parses + boots, ledger met, run green, zip on disk).

Checkpoints pause the flight for a human: config approval before anything is written, PRD source, portify apply (only when edits are proposed), a non-green terminal run (rerun vs export-as-is), and missing env secrets — that last one is never skipped, even with `--yolo`. Answer them in the terminal, in the web UI (Flights pill → routed flight view with per-stage evidence and the agent's live timeline), or over MCP (`start_flight` / `get_flight` / `respond_flight_checkpoint`; on that path, distill the conversation's requirements with `write_feature_doc` before answering the PRD-source checkpoint — dropped docs win the source hierarchy).

Flights are resumable background jobs: a crash or a failed stage parks the flight `paused`, and the next `fly` on the same repo resumes from the first open stage (`--fresh` starts over). A repo that already has a feature parks on a rerun / enhance / new choice — never a silent duplicate.

## External Authoring Workflow

External clients can use the MCP `author` profile to create durable Canary Lab tasks without asking Canary Lab to author content:

1. `create_feature` scaffolds `feature.config.cjs`, `playwright.config.ts`, and `envsets/`.
2. `capture_feature_env_files` captures existing `.env`, `.env.dev`, or `application.properties` files (responses show redacted key names only).
3. Author Playwright specs in the client, then `start_external_draft` → `update_external_draft_stage` → `apply_external_draft`.
4. Run or verify the feature; after tests pass, `start_external_evaluation_export`, generate the report, and `submit_external_evaluation_export`.

The UI marks these tasks as generated by an external client and stores stages, session names, and downloadable artifacts, but it does not replay the client transcript.
