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
4. Pick the env at the runner prompt (`canary-lab run`) or from the env dropdown in the web UI (`canary-lab ui`). Both flows apply/revert the envset and skip booting filtered services.

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

## Verified Coverage

Open the **Coverage** view (the 🎯 pill in the top bar) for a feature to see which of its PRD requirements are actually covered by *passing* runs — not just which tests exist. Requirements sit on the left, tests on the right, with synced colour highlighting between them and a grounded coverage % in the header. Gap badges (Untested, Unverified, Path-incomplete, Shallow-verified) filter the view; the **rigor** badge on each requirement shows how strict its tests are and suggests a stronger check when one is achievable. The Docs tab holds the source material the requirements are summarized from, with a "Regenerate" action that preserves requirement ids. See [Verified Coverage in FEATURES](FEATURES.md#verified-coverage) for how to annotate tests, and [COMMANDS](COMMANDS.md#verified-coverage-mcp-authorfull-profiles) for the matching MCP tools.

## Repairing a Failed Run

When a run fails, Canary Lab pauses it and waits for a fix, then reruns from the same run. Every fix ends in a `rerun` (test or config-only changes) or `restart` (service or app changes) signal. Two modes drive the fix:

### External heal (default)

An external MCP client (Claude or Codex CLI, or Claude Desktop) claims the failed run, fetches run-scoped context, fixes the app or test, and signals the next action. The orchestrator parks at `waiting-for-signal` and does not spawn its own agent. The loop is `claim_heal` → `get_heal_context` → `wait_for_heal_task` → edit code → `signal_run`.

Prefer the compact `get_heal_context` and `wait_for_heal_task` over polling; use `get_run_snapshot` only when you need verbose summaries or deeper debugging fields. If an agent session reports the Canary Lab tools are unavailable, run `npx canary-lab setup --force` and start a fresh session — MCP tools are discovered per client session, and the local HTTP API is only a fallback for custom clients.

### Auto-heal

Select **Claude** or **Codex** in Settings and Canary Lab starts that local CLI in a PTY tab when a run fails, rendering `apps/web-server/prompts/heal-agent.md` with the active run paths. Auto-heal stops when tests pass, the user stops the run, the agent exits without a useful signal, a cycle times out, or no supported CLI is available.

### Signal files

`.rerun` and `.restart` under `logs/runs/<runId>/signals/` are the low-level mechanism both modes use. You can write them by hand (or via the UI controls) to drive a fix from a custom client or while debugging. Legacy `manual` and `auto` project settings now migrate to external heal.

## External Authoring Workflow

External clients can use the MCP `author` profile to create durable Canary Lab tasks without asking Canary Lab to author content:

1. `create_feature` scaffolds `feature.config.cjs`, `playwright.config.ts`, and `envsets/`.
2. `capture_feature_env_files` captures existing `.env`, `.env.dev`, or `application.properties` files (responses show redacted key names only).
3. Author Playwright specs in the client, then `start_external_draft` → `update_external_draft_stage` → `apply_external_draft`.
4. Run or verify the feature; after tests pass, `start_external_evaluation_export`, generate the report, and `submit_external_evaluation_export`.

The UI marks these tasks as generated by an external client and stores stages, session names, and downloadable artifacts, but it does not replay the client transcript.
