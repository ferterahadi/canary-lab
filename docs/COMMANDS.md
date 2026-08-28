# Canary Lab Commands

CLI reference for Canary Lab. For the overview, quick start, and core workflow, see the [README](../README.md).

```bash
npx canary-lab flight <repo-path...> "<what to test>" [--feature <name>] [--env <envset>] [--coverage-target <pct>] [--base <branch>] [--from-stage <key>] [--redo] [--yolo] [--fresh]
npx canary-lab init <folder> [--package-spec <spec>] [--port <port>] [--no-install]
npx canary-lab setup [--workspace <path>] [--agent auto|codex|claude|all] [--dry-run] [--force]
npx canary-lab ui
npx canary-lab mcp [--url <url>] [--profile repair|verify|author|coverage|export|flight|portify|lifecycle|full|compact] [--client-kind <kind>]
npx canary-lab mcp doctor [--profile repair|verify|author|coverage|export|flight|portify|lifecycle|full|compact]
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
- Autopilot answers seven routine checkpoints. Existing-suite choices, missing secrets, and failed automatic answers still reach you. See [Checkpoints and autopilot](GUIDE.md#checkpoints-and-autopilot).
- `--redo` restarts the existing flight. `--from-stage <key>` re-enters at a stage after checking its prerequisites. `--fresh` creates a new suite.
- Repos and the test description are fixed after startup. To change them, stop and delete the flight in the UI, then start again.
- Exit codes are `0` for green, `1` for a completed non-green run, `2` for a checkpoint, and `3` for failure.

The web UI and MCP tools (`start_flight`, `get_flight`, and `respond_flight_checkpoint`) use the same flight record.

### Other commands

- `init` creates the workspace, installs dependencies and Chromium, and registers agent skills plus the compact MCP profile. Use `--no-install` for CI or offline setup.
- `ui` starts the main human interface. Its port comes from `canary-lab.config.json`; change it in Project Settings, not with `ui --port`.
- `setup` refreshes agent skills and registers only the `compact` MCP profile. It exposes one always-loaded `exec` tool that dispatches every Canary Lab command, including Portify. `--force` replaces existing entries, `--dry-run` previews changes, and `--agent` limits the target.
- `boot` starts a suite's services without tests. It requires the UI server; `boot stop <runId>` ends the session.
- `mcp` connects an AI client to the UI server. A bare command and setup-installed clients both default to `compact`; focused profiles, `lifecycle`, and `full` remain opt-in direct-tool surfaces for debugging and rollback.
- `new feature` creates a suite deterministically. `env` applies or restores an envset.
- `upgrade` refreshes managed workspace files, existing agent skills, and existing MCP connections. It also repairs the browser-install hook and downloads the matching browser when an older workspace needs it. It does not install a newer npm package by itself.

### Upgrade from 1.5.x to 2.0.0

Install Node 22.12 or newer first, then run:

```bash
npm install --save-dev canary-lab@2
npx canary-lab upgrade
```

Restart `canary-lab ui` and connected agent apps afterwards. The 2.0 UI Update
button runs both commands for you. When the 1.5.x Update button installs 2.0 but
its older updater cannot run the new migration, the first 2.0 startup detects
the 1.5.x workspace stamp and finishes that migration before serving the UI.
Upgrade preserves existing suite folders, personal `CLAUDE.md` / `AGENTS.md`
notes, custom skills, and unrelated `package.json` fields. The 2.0 demonstration
apps ship only in newly initialized workspaces; upgrading an existing workspace
does not add or replace samples.

## Compact MCP invocation

Setup-installed clients list one public tool, `exec`. Pass the exact atomic tool
name as `command` and keep its inputs in the structured `arguments` object:

```json
{"command":"<exact_tool_name>","arguments":{"feature":"<feature_name>"}}
```

That is the suite-scoped shape; commands with different inputs use the
argument fields returned by `describe_tool`.

`list_tools`, `search_tools`, and `describe_tool` are internal discovery
commands reached through the same `exec` shape. Do not prefix commands with
verbs such as `learn` or `call`. The `full` profile still exposes all 63 atomic
tools directly if a client needs the old surface.

## Requirement Coverage (MCP, `compact` or direct `coverage`/`lifecycle`/`full` profiles)

MCP and the UI use the same coverage computation:

- `get_feature_coverage(feature)` — the full ledger: each requirement → its mapped tests → a gap type (`covered` / `path-incomplete` / `variant-incomplete` / `untested`), the coverage %, and the per-test strictness grade with a suggested stronger check.
- `list_feature_docs(feature)` — the docs that feed the PRD (source vs generated), plus the summary status.
- `start_external_summary(feature)` → `submit_external_summary(jobId, requirements)` — you derive requirements from the returned source docs; Canary Lab preserves existing IDs and writes the summary. Add docs first with `write_feature_doc`.
- `start_external_coverage(feature)` → `submit_external_coverage(jobId, mappings)` — you map tests to requirements; Canary Lab writes the `@req-*` tags and recomputes coverage. Requires a summary.

Tests link to requirements through Playwright tags on each `test()` — `{ tag: ['@req-<id>', '@path-happy|sad|edge'] }`. Legacy `@requirement` and `@path` comments still work. Coverage tools map existing tests; Flight's authoring stage can create tests for uncovered requirements. See [FEATURES](FEATURES.md#requirement-coverage).

## Trigger-surface parity (skill / MCP / REST / UI)

The profile column names the focused direct-tool profile. The setup-installed
`compact` profile reaches every listed atomic tool through `exec`.

Major capabilities share stores, so work started on one surface appears on the others:

| Capability | Agent skill | MCP profile (tools) | REST | UI |
|---|---|---|---|---|
| Flight (end-to-end) | `/canary-lab` | `flight` — `start_flight` / `get_flight` / `respond_flight_checkpoint` | `POST/GET /api/flights*` | Flights pill → flight view |
| Run + heal | `/canary-lab-run` | `repair` — `start_run` / `wait_for_heal_task` / `signal_run` … | `/api/runs*` | suite Runs column / run detail |
| Deployed verification | `/canary-lab-verify` | `verify` — `execute_verification` … | `/api/verification*` | Verify dialog |
| Suite authoring | `/canary-lab-author` | `author` — `create_feature` / draft flow / envsets | `/api/features*` | Flight → Test authoring & coverage stage / config editor |
| Coverage ledger | `/canary-lab-coverage` | `coverage` — summary/coverage jobs + ledger | `/api/coverage*` | Coverage ledger page (Suites column) |
| Portify | `/canary-lab-portify` | `portify` — external portify workflow | `/api/portify*` | Flight → Parallel readiness stage (also run-collision recovery); Ports tab reports injectability |
| Evaluation export | `/canary-lab-export` | `export` — evaluation export tools | `/api/evaluation*` | run detail → Export Evaluation |

If a new capability lands with a missing cell, that's a gap — the parity bar is part of the product, not a coincidence.
