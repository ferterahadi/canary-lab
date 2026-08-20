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

## Command Details

### `flight`

`flight` takes one or more product repos from suite setup through evaluation export.

- It creates or finds the workspace and starts the server when needed.
- Autopilot answers seven routine checkpoints. Existing-feature choices, missing secrets, and failed automatic answers still reach you. See [Checkpoints and autopilot](GUIDE.md#checkpoints-and-autopilot).
- `--redo` restarts the existing flight. `--from-stage <key>` re-enters at a stage after checking its prerequisites. `--fresh` creates a new feature.
- Repos and the test description are fixed after startup. To change them, stop and delete the flight in the UI, then start again.
- Exit codes are `0` for green, `1` for a completed non-green run, `2` for a checkpoint, and `3` for failure.

The web UI and MCP tools (`start_flight`, `get_flight`, and `respond_flight_checkpoint`) use the same flight record.

### Other commands

- `init` creates the workspace, installs dependencies and Chromium, and registers agent tools. Use `--no-install` for CI or offline setup.
- `ui` starts the main human interface. Its port comes from `canary-lab.config.json`; change it in Project Settings, not with `ui --port`.
- `setup` refreshes agent registration. `--force` replaces existing entries, `--dry-run` previews changes, and `--agent` limits the target.
- `boot` starts a feature's services without tests. It requires the UI server; `boot stop <runId>` ends the session.
- `mcp` connects an AI client to the UI server. The default `lifecycle` profile covers authoring through export. Use a narrower profile when possible, `portify` for port injection, or `full` for every tool.
- `new feature` creates a feature deterministically. `env` applies or restores an envset.
- `upgrade` refreshes managed workspace files and skills. It does not upgrade the npm dependency.

## Requirement Coverage (MCP, `coverage`/`lifecycle`/`full` profiles)

MCP and the UI use the same coverage computation:

- `get_feature_coverage(feature)` — the full ledger: each requirement → its mapped tests → a gap type (`covered` / `path-incomplete` / `variant-incomplete` / `untested`), the coverage %, and the per-test strictness grade with a suggested stronger check.
- `list_feature_docs(feature)` — the docs that feed the PRD (source vs generated), plus the summary status.
- `start_external_summary(feature)` → `submit_external_summary(jobId, requirements)` — you derive requirements from the returned source docs; Canary Lab preserves existing IDs and writes the summary. Add docs first with `write_feature_doc`.
- `start_external_coverage(feature)` → `submit_external_coverage(jobId, mappings)` — you map tests to requirements; Canary Lab writes the `@req-*` tags and recomputes coverage. Requires a summary.

Tests link to requirements through Playwright tags on each `test()` — `{ tag: ['@req-<id>', '@path-happy|sad|edge'] }`. Legacy `@requirement` and `@path` comments still work. Coverage tools map existing tests; Flight's authoring stage can create tests for uncovered requirements. See [FEATURES](FEATURES.md#requirement-coverage).

## Trigger-surface parity (skill / MCP / REST / UI)

Major capabilities share stores, so work started on one surface appears on the others:

| Capability | Agent skill | MCP profile (tools) | REST | UI |
|---|---|---|---|---|
| Flight (end-to-end) | `/canary-lab` | `flight` — `start_flight` / `get_flight` / `respond_flight_checkpoint` | `POST/GET /api/flights*` | Flights pill → flight view |
| Run + heal | `/canary-lab-run` | `repair` — `start_run` / `wait_for_heal_task` / `signal_run` … | `/api/runs*` | feature Runs column / run detail |
| Deployed verification | `/canary-lab-verify` | `verify` — `execute_verification` … | `/api/verification*` | Verify dialog |
| Feature authoring | `/canary-lab-author` | `author` — `create_feature` / draft flow / envsets | `/api/features*` | Flight → Test authoring & coverage stage / config editor |
| Coverage ledger | `/canary-lab-coverage` | `coverage` — summary/coverage jobs + ledger | `/api/coverage*` | Coverage ledger page (Suites column) |
| Portify | `/canary-lab-portify` | `portify` — external portify workflow | `/api/portify*` | Flight → Parallel readiness stage (also run-collision recovery); Ports tab reports injectability |
| Evaluation export | `/canary-lab-export` | `export` — evaluation export tools | `/api/evaluation*` | run detail → Export Evaluation |

If a new capability lands with a missing cell, that's a gap — the parity bar is part of the product, not a coincidence.
