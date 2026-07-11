---
name: canary-lab
description: Use when the user wants Canary Lab to take a product repo end to end — "test this app", "onboard this repo", "run a flight", "evaluate what I just built" — through the flight pipeline (start_flight / get_flight / respond_flight_checkpoint over MCP). One conducted background pipeline goes from bare repo(s) to a green, covered, healed run ending in an evaluation export. For a single capability use the focused skills instead — canary-lab-run (run + heal), canary-lab-verify (deployed-env verification), canary-lab-author (create feature + specs), canary-lab-coverage (PRD summary + coverage ledger), canary-lab-portify (concurrency-readiness), canary-lab-export (evaluation export).
type: skill
---

# Canary Lab — Flight

The server computes every stage verdict; this client only answers
checkpoints. The flight is Canary Lab's front door: one command/tool takes
one or more bare product repos to a green, healed, covered run that ends in
an evaluation export. These tools arrive via the Canary Lab MCP server. If
this client is already connected (the plugin connects with `full`), skip
this step. To configure a connection manually: `npx canary-lab mcp --profile
flight` (the composite `lifecycle`/`full` profiles carry the same tools).

## Workspace Bootstrap

Before calling Canary Lab MCP tools, make sure the workspace and UI server are available.

1. Read the user-level registry at `~/.canary-lab/workspaces.json`. On Windows, resolve it from the user's home directory, for example `%USERPROFILE%\.canary-lab\workspaces.json`.
2. If the registry has exactly one workspace, use that workspace. If it has multiple workspaces, list their `name` and `path` values and ask which one to use.
3. If the registry is missing or empty, ask the user to run `npx canary-lab setup` from the Canary Lab workspace.
4. Check the MCP health endpoint: read `port` from the workspace's `canary-lab.config.json` (fallback `7421`), then `curl -s http://127.0.0.1:<port>/mcp/health` — success is a JSON response. If it does not respond, run `npx canary-lab mcp doctor` to discover the active URL.
5. If the health check succeeds, confirm `projectRoot` matches the selected workspace. If it points at a different workspace, ask the user whether to stop the existing Canary Lab server before continuing.
6. If the health check fails, start `npx canary-lab ui` from the selected workspace in a visible long-running terminal when the host supports that; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up. The port comes from `canary-lab.config.json` (default `7421`); do not pass `--port` (it was removed).

## Flight (end-to-end pipeline)

1. `start_flight(repoPaths, description)` runs ONE background pipeline from bare repo(s) to a green, covered, healed run ending in an evaluation export (similarity → scout → scaffold → env → docs → PRD → specs↔coverage → portify → run → heal → export). The server conducts every stage and computes every verdict — you only approve checkpoints; do not run the stages yourself or start a separate run/coverage pass alongside an active flight.
2. Follow with `get_flight(flightId)` and do what its `next:` field says. On `waiting-for-approval`, call `respond_flight_checkpoint(flightId)` with `choice` (one of `checkpoint.options`), `values` (a missing-env KEY→value map), or `data` (`{ configSource }` for config-approval — the feature is already scaffolded, so this writes through to its REAL on-disk feature.config.cjs; `redraft` re-runs the repo scan). Before the terminal export, the `export-mode` checkpoint picks `raw` (fast report) vs `localized` (agent-rewritten reasoning). A checkpoint payload over the inline budget is omitted from the tool result — review it in the web UI flight view, then respond here.
3. The `prd-source` checkpoint ALWAYS parks (the Requirements stage pauses by design). FIRST add requirements with `write_feature_doc` — distilled from this conversation (`content`) or linking a local file (`link_path`, symlinked so the user's original stays live) — then respond `continue`, or pick a source to infer from.
4. ONE flight record per feature — never a silent second manifest. Re-calling `start_flight` follows an active flight and resumes a paused one from its first open stage; a settled one requires `redo: true` (restart from stage 1, discarding its stage evidence) or `from_stage: "<stage>"` (jump to a chosen stage — prerequisites are checked and a rejection names the missing artifact, e.g. no specs yet). The CLI equivalents are `--redo` and `--from-stage <key>`. `fresh: true` skips resuming a paused flight and starts over instead. `yolo: true` skips every checkpoint except missing env secrets (export defaults to raw).
5. A flight's **repos and intent are frozen** once it first starts. On redo / `from_stage` / resume, **OMIT `repoPaths` and `description`** — the stored values are reused. Passing a DIFFERENT repo set or description is rejected with `type: "flight_frozen"` ("a flight's repos and intent are set when it first starts; delete the flight to start fresh with different ones"). There is no delete tool or CLI flag — the user deletes a flight in the web UI, then a fresh `start_flight` can pick new repos/intent.
6. A flight parked `status: "paused"`, `pauseReason: "queued"` is **waiting its turn** behind another flight on the same repo(s) (a broad intent split into per-feature flights runs them sequentially). It **starts automatically** when that repo frees — narrate it as queued, not stuck, and do NOT ask the user to resume it. Only if they want it started early, re-calling `start_flight` resumes it now. (The other pause reasons — `user` / `stage-failed` / `restart` — are the resumable pauses that a re-call picks up.)
7. On `done`, `links.evaluationZip` is the deliverable — point the user at opening the evaluation export (video playback where the tests drive a browser, plus the per-test reasoning in `evaluation.html`) as their immediate next step. Reviewing that export IS the core Canary Lab loop, not an optional extra.

The same flight is drivable from the CLI (`npx canary-lab flight <repo...> "<what to test>"`), the web UI (Flights pill), and this MCP surface — all against one store, so progress and checkpoints stay in sync everywhere.

## Follow loop

While `status` is `running`, re-call `get_flight(flightId)` (wait ~20s between
calls). Stop states: `done`, `failed`, `paused` (when `pauseReason` is not
`queued`). On `waiting-for-approval`, respond to the checkpoint instead of
waiting.

| Status | Action |
| --- | --- |
| `running` | Wait ~20s, re-call `get_flight`. |
| `waiting-for-approval` | Respond via `respond_flight_checkpoint`. |
| `paused`, `pauseReason: "queued"` | Narrate as waiting — do NOT resume it. |
| `paused`, other `pauseReason` | Re-call `start_flight` (OMIT `repoPaths` + `description`) to resume. |
| `done` | Point the user at `links.evaluationZip`. |
| `failed` | Report the failure; a re-call to `start_flight` resumes from the failed stage. |

## Guardrails

- **On redo / `from_stage` / resume: OMIT `repoPaths` and `description`** — the flight's repos and intent are frozen after it first starts.
- Flight tools take no `session_id` (only tools that declare `session_id` in their schema take one; `start_flight` / `get_flight` / `respond_flight_checkpoint` do not).
- The flight conducts run/heal/coverage/portify itself. While a flight is active, do not drive those stages with the focused skills — answer the flight's checkpoints instead.
- For one capability on its own (a run, a coverage pass, an export), use the matching focused skill: `canary-lab-run`, `canary-lab-verify`, `canary-lab-author`, `canary-lab-coverage`, `canary-lab-portify`, `canary-lab-export`.
