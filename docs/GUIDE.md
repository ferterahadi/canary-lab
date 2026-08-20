# Canary Lab Guide

Operational reference for Canary Lab. See the [README](../README.md) for setup and the main workflow.

## Environment Switching

Envsets are temporary feature environment files. Canary Lab backs up target files, applies the selected envset, and restores the originals after the run. Manage them under **Envsets**; files live in `features/<feature>/envsets/`.

Feature configs can make service startup env-specific — for example, a `local` env starts services while a `production` env skips local startup and points tests at a deployed URL.

### Testing Against a Remote URL

To run a feature's tests against a deployed environment without booting the local server:

1. Add the env to `feature.config.cjs` → `envs: ['local', 'production']`.
2. Gate each `startCommand` (or whole `repo`) with `envs: ['local']` so it only boots locally.
3. Add a matching envset under `envsets/<env>/<feature>.env` with the remote target — e.g. `GATEWAY_URL=https://api.example.com`. Tests read this via `process.env.GATEWAY_URL` (see `e2e/helpers/api.ts`).
4. Pick the env from the env dropdown in the web UI (`canary-lab ui`). The run flow applies/reverts the envset and skips booting filtered services.

### Environment Variable Safety

Envsets may contain credentials. The default `.gitignore` excludes `features/*/envsets/*/*`. Review any value file you force-add before pushing.

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

Export a completed run from its **Overview** tab. The `.zip` contains `evaluation.html` and captured videos, with each test's flow, code, helpers, evidence, and checks.

When the feature has a PRD summary, the report compares semantic coverage with what this run proved. A requirement is proven only when its mapped test passed in the exported run; Canary Lab never borrows the outcome from another run.

The Export menu offers two formats. **Raw** renders directly from evidence and uses no LLM. **Localized** asks a local agent to improve the per-test explanation. Both keep the same tests and verdicts. External MCP exports use wording supplied by the connected client.

![Evaluation Report sample](assets/assertion-review.png)

## Requirement Coverage

Open **Coverage** from a suite row. The ledger shows each requirement, path, variant, and mapped test; tags determine the percentage. Filters show coverage gaps, while strictness measures assertion depth. Regeneration preserves stable requirement IDs. See [FEATURES](FEATURES.md#requirement-coverage) for tags and [COMMANDS](COMMANDS.md#requirement-coverage-mcp-coveragelifecyclefull-profiles) for MCP tools.

## Repairing a Failed Run

When a run fails, Canary Lab pauses, waits for a repair, and continues the same run. Use `rerun` when no service restart is needed and `restart` after application or service changes.

### Where the repair lands

Each repo runs in a Git worktree created from `HEAD`, including uncommitted changes and shared `node_modules`. **The repair agent edits the worktree, not your checkout.**

At teardown, Canary Lab saves `<repo>.patch` under `logs/runs/<runId>/fixes/`, writes `fixes.json`, and removes normal worktrees. A passing repair can update `canary-lab/fix-<feature>-<repo>` and open a draft pull request; disable this under **Settings → GitHub**. Failed or abandoned repairs are never pushed.

Portified features are the exception on teardown: their overlay is reverse-applied but the worktree is kept, since it holds the repair. The Cleanup page's **Worktrees** tab lists, opens, and removes those.

### External heal (default)

An external MCP client claims the failed run, reads its evidence, fixes application or service code, and signals the next action. It may change a test only when the test is provably wrong. The loop is `claim_heal` → `get_heal_context` → `wait_for_heal_task` → edit → `signal_run`.

Use `get_heal_context` and `wait_for_heal_task` instead of polling; reserve `get_run_snapshot` for deeper debugging. If tools are unavailable, run `npx canary-lab setup --force` and start a fresh session. MCP tools load per client session; the HTTP API is a fallback for custom clients.

### Auto-heal

Select **Claude** or **Codex** in Settings and Canary Lab starts that local CLI in a PTY tab when a run fails, rendering `apps/web-server/prompts/heal-agent.md` with the active run paths. Auto-heal stops when tests pass, the user stops the run, the agent exits without a useful signal, a cycle times out, or no supported CLI is available.

### Signal files

`.rerun` and `.restart` under `logs/runs/<runId>/signals/` are the low-level mechanism both modes use. You can write them by hand (or via the UI controls) to drive a fix from a custom client or while debugging.

Two values hidden from Settings remain valid in `canary-lab.config.json`, the config API, and `handoff_heal`: `manual` waits for hand-driven signals; `auto` selects a supported CLI from `PATH`. Existing projects keep their value.

## Flight (`canary-lab flight`)

`npx canary-lab flight <repo...> "<what to test>"` takes a bare repo through setup, requirements, test authoring, coverage, parallel readiness, execution, repair, and evaluation export.

Agents draft the config, collect requirements, and author tests. Canary Lab verifies the config by booting it, calculates coverage from tags, runs the tests, and confirms that the evaluation archive exists. The default coverage target is 100%. Portify uses a concurrent double boot to prove the feature can run with injected ports; skipping it leaves the feature serial.

### Checkpoints and autopilot

A flight has nine checkpoints. **Autopilot answers seven by default**, logging each as `[autopilot]`. It stops only when a machine cannot decide:

| Checkpoint | Asks | Autopilot |
|---|---|---|
| `similarity-choice` | This repo already has a feature — rerun / enhance / new? | ❌ always asks |
| `config-approval` | Approve the scaffolded, on-disk `feature.config.cjs` (edit it on the Suite setup stage or in Advanced setup; `redraft` re-runs the repo scan) | `approve` |
| `prd-source` | Supply requirement docs, or have an agent gather them (`collect-repo-docs` / `infer-from-diff`) | `continue` when docs exist — **`collect-repo-docs` when none do**, so the fork is not a stop |
| `coverage-stuck` | The authoring loop can't reach the target | `accept-partial` |
| `portify-gate` | Run the parallel-readiness workflow at all, before any agent cost? | `run` |
| `portify-apply` | Review the verified diff — `apply` / `revise` (needs feedback) / `cancel` | `apply` |
| `run-failed` | Terminal run isn't green — rerun or export as-is? | `export-as-is` |
| `export-mode` | `raw` (fast) vs `localized` (agent-rewritten reasoning) | `raw` |
| `missing-env` | Secrets the env capture couldn't find | ❌ never skipped, not even with `--yolo` |

Two rules override autopilot. A checkpoint that **re-parks** after an automatic answer always reaches you; autopilot never answers it twice. A deliberately re-entered stage also parks its first checkpoint so you can choose differently.

Turn autopilot off to answer every checkpoint. Use the flight header toggle or pass `autopilot: false` to `start_flight`; changes apply at the next checkpoint.

Answer checkpoints in the terminal, the Flight view, or through `respond_flight_checkpoint`. From MCP, use `write_feature_doc` to add Markdown content or link a local file before answering `prd-source`. The Flight view shows stage evidence and live agent activity; a suite's paper-plane action opens its existing flight.

### Resuming, redoing, and queueing

Flights are resumable background jobs. After a crash or failed stage, the next command starts at the first unfinished stage. Use `--fresh` for a new feature; existing features trigger a rerun, enhance, or new-feature checkpoint.

A flight's repos and description are fixed after it starts. Resume, redo, and stage re-entry reuse those values. To change them, stop the flight and delete its record in the web UI. Deletion keeps the feature and its files. There is no CLI or MCP delete operation.

In the web UI, a broad description can be split into several proposed features for confirmation. The first flight starts and the rest wait for the shared repos to become free. Features with the same `group` value appear under one accordion. This multi-feature planning flow is not available through CLI or MCP.

## External Authoring Workflow

External clients can create durable tasks without Canary Lab authoring the content. Use the default `lifecycle` profile, which combines the three profiles below:

1. *(`author`)* `create_feature` scaffolds `feature.config.cjs`, `playwright.config.ts`, and `envsets/`.
2. *(`author`)* `capture_feature_env_files` captures existing `.env`, `.env.dev`, or `application.properties` files (responses show redacted key names only).
3. *(`author`)* Author Playwright specs in the client, then `start_external_draft` → `update_external_draft_stage` → `apply_external_draft`.
4. *(`repair` / `verify`)* Run or verify the feature.
5. *(`export`)* After tests pass, `start_external_evaluation_export`, generate the report, and `submit_external_evaluation_export`.

A client narrowed to `--profile author` gets steps 1–3 only; it will not see the run, verify, or export tools.

The UI marks these tasks as generated by an external client and stores stages, session names, and downloadable artifacts, but it does not replay the client transcript.
