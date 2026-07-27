# Canary Lab Commands

CLI reference for Canary Lab. For the overview, quick start, and core workflow, see the [README](../README.md).

```bash
npx canary-lab flight <repo-path...> "<what to test>" [--feature <name>] [--env <envset>] [--coverage-target <pct>] [--base <branch>] [--from-stage <key>] [--redo] [--yolo] [--fresh]
npx canary-lab init <folder> [--package-spec <spec>] [--port <port>] [--no-install]
npx canary-lab setup [--workspace <path>] [--agent auto|codex|claude|all] [--dry-run] [--force]
npx canary-lab ui
npx canary-lab mcp [--url <url>] [--profile repair|verify|author|coverage|export|flight|portify|lifecycle|full] [--client-kind <kind>]
npx canary-lab mcp doctor [--profile repair|verify|author|coverage|export|flight|portify|lifecycle|full]
npx canary-lab new feature <name> --description "..."
npx canary-lab env apply <feature> <set>
npx canary-lab env revert <feature>
npx canary-lab boot <feature> [env]
npx canary-lab boot stop <runId>
npx canary-lab upgrade [--silent] [--check] [--force-archive]
```

- `flight` is the one-command onboarding: it takes bare product repo(s) to a green, covered, healed run ending in an evaluation archive (similarity check → repo scout → scaffold → env capture → docs/PRD → specs↔coverage loop → portify → run → heal → export). It locates or creates the workspace, boots the server if needed, and streams stage progress to the terminal. **Autopilot is on by default**, so of the nine checkpoints only two always reach you — the similarity choice (this repo already has a feature) and missing env values — plus `prd-source` when the feature has no requirement docs yet, and any checkpoint that re-parks after a failed auto-answer. The other seven self-answer with a safe default (`config-approval`→approve, `prd-source`→continue, `coverage-stuck`→accept-partial, `portify-gate`→run, `portify-apply`→apply, `run-failed`→export-as-is, `export-mode`→raw), each logged `[autopilot]` on its stage; see [GUIDE → Checkpoints and autopilot](GUIDE.md#checkpoints-and-autopilot) for what each one asks and how to turn autopilot off. `--yolo` goes further and skips the remaining checkpoints too — except missing env values, which are never skipped. Several repo paths become ONE feature spanning them. A feature has exactly ONE flight record: re-running `flight` resumes an interrupted flight from its failed stage; on a settled flight it offers **continue / redo / jump** (`--redo` restarts from stage 1 discarding the record's stage evidence; `--from-stage <key>` starts at a chosen stage — prerequisites are checked and a rejection names the missing artifact, e.g. jumping to `run` with no specs authored). A flight's **repos and intent are frozen** once it first starts: `--redo`/`--from-stage` reuse the stored repos + description, so omit the positionals (name the flight with `--feature <name>` when there is no repo path to match on); passing DIFFERENT repos or a different description is rejected and the CLI points you at the reuse form or at **deleting the flight in the web UI** to start fresh with different ones (there is no delete command or MCP tool — deletion is a web-UI action). `--fresh` is for a brand-new feature. A repo that already has a feature parks on a rerun/enhance/new choice instead of duplicating it. Exit code: `0` green, `1` done with a non-green run (archive still produced), `2` parked on a checkpoint, `3` failed. The same flight is drivable from the web UI (Flights pill) and over MCP (`start_flight` / `get_flight` / `respond_flight_checkpoint`).
- `init` scaffolds the workspace, then runs `npm install` + the Playwright browser download and registers tools — so `ui` boots immediately. Pass `--no-install` to scaffold only (CI / offline) and install manually afterward.
- `ui` is the primary human workflow.
- `setup` refreshes the agent/tool registration described in [Quick Start](../README.md#quick-start). `--force` rewrites registrations that already exist, `--dry-run` prints what would change, and `--agent` narrows it to one CLI.
- `boot` starts a feature's services and holds them without running any tests — for poking at the app by hand. It needs `canary-lab ui` running; `boot stop <runId>` tears the session down.
- `mcp` bridges local AI clients into the UI server, starting it if needed. It defaults to `lifecycle` — the everyday end-to-end loop (authoring + coverage + flight + run/heal + verify + export, no portify). Narrow it with `--profile repair` for run/heal only, `--profile verify` for deployment checks, `--profile author` for feature/spec authoring, `--profile coverage` for docs → PRD summary → coverage ledger, `--profile export` for evaluation archives, `--profile flight` for the end-to-end pipeline; use `--profile portify` for the specialized port-injection workflow, or `--profile full` for the complete surface (lifecycle + portify). Each profile has a matching agent skill (`/canary-lab`, `/canary-lab-run`, `/canary-lab-verify`, `/canary-lab-author`, `/canary-lab-coverage`, `/canary-lab-portify`, `/canary-lab-export`).
- `new feature` and `env` are deterministic wrappers for scripts and agents.
- `upgrade` syncs scaffolded docs and skills in an existing project (not a dependency upgrade).

## Requirement Coverage (MCP, `coverage`/`lifecycle`/`full` profiles)

The coverage ledger is reachable over MCP as well as the UI — both call the same computation, so they can't diverge:

- `get_feature_coverage(feature)` — the full ledger: each requirement → its mapped tests → a gap type (`covered` / `path-incomplete` / `variant-incomplete` / `untested`), the coverage %, and the per-test strictness grade with a suggested stronger check.
- `list_feature_docs(feature)` — the docs that feed the PRD (source vs generated), plus the summary status.
- `start_external_summary(feature)` → `submit_external_summary(jobId, requirements)` — YOU read the source docs (returned in the prompt) and propose the requirements; canary reconciles ids (preserving existing ones) and writes the summary. No local agent — over MCP you author it. Add docs first with `write_feature_doc`.
- `start_external_coverage(feature)` → `submit_external_coverage(jobId, mappings)` — YOU read the tests and map them to requirements; canary writes the `@req-*` tags and recomputes. Needs a summary first.

Tests link to requirements via Playwright tags on each `test()` — `{ tag: ['@req-<id>', '@path-happy|sad|edge'] }` (legacy `@requirement`/`@path` comments still parse); see [FEATURES](FEATURES.md#requirement-coverage). Canary computes coverage from your tags; it never writes a requirement's test for you.

## Trigger-surface parity (skill / MCP / REST / UI)

Every capability is triggerable identically from four surfaces, all against the same store — start something on one surface and every other surface sees it live:

| Capability | Agent skill | MCP profile (tools) | REST | UI |
|---|---|---|---|---|
| Flight (end-to-end) | `/canary-lab` | `flight` — `start_flight` / `get_flight` / `respond_flight_checkpoint` | `POST/GET /api/flights*` | Flights pill → flight view |
| Run + heal | `/canary-lab-run` | `repair` — `start_run` / `wait_for_heal_task` / `signal_run` … | `/api/runs*` | feature Runs column / run detail |
| Deployed verification | `/canary-lab-verify` | `verify` — `execute_verification` … | `/api/verification*` | Verify dialog |
| Feature authoring | `/canary-lab-author` | `author` — `create_feature` / draft flow / envsets | `/api/features*` | Flight → Test authoring & coverage stage / config editor |
| Coverage ledger | `/canary-lab-coverage` | `coverage` — summary/coverage jobs + ledger | `/api/coverage*` | Coverage ledger page (features column) |
| Portify | `/canary-lab-portify` | `portify` — external portify workflow | `/api/portify*` | Flight → Parallel readiness stage (also run-collision recovery); Ports tab reports injectability |
| Evaluation export | `/canary-lab-export` | `export` — evaluation export tools | `/api/evaluation*` | run detail → Export Evaluation |

If a new capability lands with a missing cell, that's a gap — the parity bar is part of the product, not a coincidence.
