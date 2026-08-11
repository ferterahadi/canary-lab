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

Completed runs can export an Evaluation Report from the run detail Overview tab — a `.zip` containing `evaluation.html` and captured videos. It summarizes what was tested, the result, and the evidence; each test case expands to show its flowchart, test code, helper code, videos, and checks. When the feature has a PRD summary, the report also opens with a semantic-coverage banner — what the tags claim is covered, beside how much of that this run actually **proved** (a requirement whose covering test passed). The proven figure appears only when the coverage ledger was joined against the very run the report is headed by, so it never attributes another run's outcome to this one.

The Export menu offers two flavors. **Raw output** renders straight from the run evidence — fast, no LLM involved. **Localized output** spawns a local agent to rewrite the per-test reasoning for readability, so it takes longer; you can watch it run in the agent view. Both cover the same tests with the same verdicts — only the wording differs. Exports driven by an external MCP client are always client-authored (Canary Lab never rewrites those).

![Evaluation Report sample](assets/assertion-review.png)

## Requirement Coverage

Open the **Coverage** view (the target icon on a feature's row in the features column) to see which of a feature's PRD requirements have tests mapped — every requirement × path (× variant) cell, not just a test count. Requirements on the left, tests on the right, synced colour highlighting, and a coverage % canary computes from the tags rather than an agent's guess. Gap badges (Untested, Path-incomplete, Variant-incomplete) filter the view; a **strictness** badge grades how deep each test checks — app log → internal state → app API → real browser effect — and suggests a stronger assertion where achievable. The Docs tab holds the PRD's source material, with a "Regenerate" action that preserves requirement ids. See [FEATURES](FEATURES.md#requirement-coverage) for annotating tests and [COMMANDS](COMMANDS.md#requirement-coverage-mcp-coveragelifecyclefull-profiles) for the MCP tools.

## Repairing a Failed Run

When a run fails, Canary Lab pauses it and waits for a fix, then reruns from the same run. Every fix ends in a `rerun` (test or config-only changes) or `restart` (service or app changes) signal. Two modes drive the fix:

### Where the repair lands

Every test run boots inside a per-run `git worktree` for each of the feature's repos — cut from `HEAD`, with your uncommitted changes hydrated in and `node_modules` symlinked from the source repo, so the run tests your work-in-progress without occupying your checkout. **The heal agent edits that worktree, not your working copy.** At teardown Canary Lab diffs the worktree against a pre-boot baseline and writes the repair to `logs/runs/<runId>/fixes/<repo>.patch` (plus `fixes.json`), then removes the worktree. Your working copy is left as you had it. If the run then went green, Canary Lab force-pushes that patch to a `canary-lab/fix-<feature>-<repo>` branch and opens a **draft** pull request, so the repair is waiting for review rather than sitting in a patch file — one PR per feature, updated in place by each later heal. Turn it off with the "Open a draft PR when a run heals green" checkbox under Settings → GitHub; nothing is pushed for a run that failed or gave up.

Portified features are the exception on teardown: their overlay is reverse-applied but the worktree is kept, since it holds the repair. The Cleanup page's **Worktrees** tab lists, opens, and removes those.

### External heal (default)

An external MCP client (Claude or Codex CLI, or Claude Desktop) claims the failed run, fetches run-scoped context, fixes the app or test, and signals the next action. The orchestrator parks at `waiting-for-signal` and does not spawn its own agent. The loop is `claim_heal` → `get_heal_context` → `wait_for_heal_task` → edit code → `signal_run`.

Prefer the compact `get_heal_context` and `wait_for_heal_task` over polling; use `get_run_snapshot` only when you need verbose summaries or deeper debugging fields. If an agent session reports the Canary Lab tools are unavailable, run `npx canary-lab setup --force` and start a fresh session — MCP tools are discovered per client session, and the local HTTP API is only a fallback for custom clients.

### Auto-heal

Select **Claude** or **Codex** in Settings and Canary Lab starts that local CLI in a PTY tab when a run fails, rendering `apps/web-server/prompts/heal-agent.md` with the active run paths. Auto-heal stops when tests pass, the user stops the run, the agent exits without a useful signal, a cycle times out, or no supported CLI is available.

### Signal files

`.rerun` and `.restart` under `logs/runs/<runId>/signals/` are the low-level mechanism both modes use. You can write them by hand (or via the UI controls) to drive a fix from a custom client or while debugging.

Two further `healAgent` values exist but are no longer offered in Settings (which lists External / Claude / Codex): `manual` disables auto-heal and parks the run for hand-driven signals, and `auto` picks whichever supported CLI is on `PATH`. Both remain valid in `canary-lab.config.json`, over the config API, and as `handoff_heal` targets — an existing project keeps whichever it was set to.

## Flight (`canary-lab flight`)

The one-command onboarding pipeline: `npx canary-lab flight <repo...> "<what to test>"` conducts a bare product repo through every stage — similarity check, repo scout (an agent drafts `feature.config.cjs` + detects env files), scaffold, env capture (proven by a single dry-run boot), docs/PRD (drop a doc, or it's inferred from repo docs / the diff vs your base branch / the description), a specs↔coverage loop that authors tagged Playwright specs until the ledger hits the target (default 100%), portify (offered up front and run by default — the double-boot verify earns the concurrency-ready mark; skip it and the feature stays serial), the run with auto-heal, and finally the evaluation export. The archive is the flight's deliverable; a stage never succeeds on the agent's say-so — canary computes every verdict (config parses + boots, ledger met, run green, zip on disk).

### Checkpoints and autopilot

A flight has nine checkpoints, but **autopilot is on by default** and answers seven of them with a safe default — each one logged `[autopilot]` on its stage. Expect an unattended flight to stop only where a machine can't decide:

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

Two overrides on top of that. A checkpoint that **re-parks** (a config parse error after an auto-approve, an unrecognized choice, a requirements collector that came back empty-handed) always reaches you — autopilot never answers the same one twice. And a stage you deliberately **re-enter** via redo or jump-to-stage always parks its first checkpoint, because choosing to re-run a step is the intent to answer it differently.

Turn autopilot off to be asked at every checkpoint: the flight header's facts strip carries an **Autopilot on/off** toggle you can flip at any time (it takes effect at the next checkpoint), and MCP clients pass `autopilot: false` to `start_flight` — worth doing when you plan to distill the conversation into requirement docs at the `prd-source` stop.

Answer checkpoints in the terminal, in the web UI (Flights pill → routed flight view with per-stage evidence and the agent's live timeline — or hover a suite in the Suites column and click its paper-plane icon, which jumps straight to that suite's flight and is tinted by its state), or over MCP (`start_flight` / `get_flight` / `respond_flight_checkpoint`; on that path, distill the conversation's requirements with `write_feature_doc` — content or `link_path` for a local file — before answering `prd-source`; dropped docs win the source hierarchy).

### Resuming, redoing, and queueing

Flights are resumable background jobs: a crash or a failed stage parks the flight `paused`, and the next `flight` on the same repo resumes from the first open stage (`--fresh` starts over). A repo that already has a feature parks on a rerun / enhance / new choice — never a silent duplicate.

A flight's **repos and intent freeze** the moment it first starts — redo, jump-to-stage, and resume all reuse the stored repos + description across the CLI, the web UI, and MCP. Passing a different repo set or description is rejected (`flight_frozen`); to change them, **delete the flight in the web UI** (Flights pill → flight → delete — only when it is not active; stop it first). Deletion drops the flight record only: the feature and its on-disk artifacts stay, and its pill row returns to "not flown" so a fresh flight can pick new repos/intent. There is no delete command or MCP tool — deletion is a web-UI action.

Broad intent, several features: in the web UI's new-flight dialog, a wide description ("test the whole app") is split by an agent into N proposed features for you to confirm; launch then creates one flight per feature. The first starts immediately and the rest are **queued** (`paused`, `pauseReason: "queued"`) — a queued flight is waiting its turn behind another flight on the same repo(s), not stuck, and auto-starts the moment that repo frees. Same-`group` features (set `group: "<name>"` in `feature.config.cjs`) render together under one accordion in the pill's feature list. (The intent breakdown is a web-UI flow; it is not exposed over the CLI or MCP.)

## External Authoring Workflow

External clients can create durable Canary Lab tasks without asking Canary Lab to author content. Connect on the default `lifecycle` profile — the walkthrough below crosses three workflow profiles, and `lifecycle` is their union:

1. *(`author`)* `create_feature` scaffolds `feature.config.cjs`, `playwright.config.ts`, and `envsets/`.
2. *(`author`)* `capture_feature_env_files` captures existing `.env`, `.env.dev`, or `application.properties` files (responses show redacted key names only).
3. *(`author`)* Author Playwright specs in the client, then `start_external_draft` → `update_external_draft_stage` → `apply_external_draft`.
4. *(`repair` / `verify`)* Run or verify the feature.
5. *(`export`)* After tests pass, `start_external_evaluation_export`, generate the report, and `submit_external_evaluation_export`.

A client narrowed to `--profile author` gets steps 1–3 only; it will not see the run, verify, or export tools.

The UI marks these tasks as generated by an external client and stores stages, session names, and downloadable artifacts, but it does not replay the client transcript.
