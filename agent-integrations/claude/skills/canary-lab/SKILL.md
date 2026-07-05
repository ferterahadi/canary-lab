---
name: canary-lab
description: Use when the user wants Canary Lab to take a product repo end to end — "test this app", "onboard this repo", "run a flight", "evaluate what I just built" — through the flight pipeline (start_flight / get_flight / respond_flight_checkpoint over MCP). One conducted background pipeline goes from bare repo(s) to a green, covered, healed run ending in an evaluation export; the server computes every stage verdict, this client only answers checkpoints. For a single capability use the focused skills instead — canary-lab-run (run + heal), canary-lab-verify (deployed-env verification), canary-lab-author (create feature + specs), canary-lab-coverage (PRD summary + coverage ledger), canary-lab-portify (concurrency-readiness), canary-lab-export (evaluation export).
type: skill
---

# Canary Lab — Flight

The flight is Canary Lab's front door: one command/tool takes one or more bare
product repos to a green, healed, covered run that ends in an evaluation
export. Connect with the `flight` MCP profile (`npx canary-lab mcp --profile
flight`); the composite `lifecycle`/`full` profiles carry the same tools.

## Workspace Bootstrap

Before calling Canary Lab MCP tools, make sure the workspace and UI server are available.

1. Read the user-level registry at `~/.canary-lab/workspaces.json`. On Windows, resolve it from the user's home directory, for example `%USERPROFILE%\.canary-lab\workspaces.json`.
2. If the registry has exactly one workspace, use that workspace. If it has multiple workspaces, list their `name` and `path` values and ask which one to use.
3. If the registry is missing or empty, ask the user to run `npx canary-lab setup` from the Canary Lab workspace.
4. Check the MCP health endpoint `/mcp/health` on the UI's port. The port defaults to `7421`, but a project may pin its own in `canary-lab.config.json`; if `7421` does not respond, run `npx canary-lab mcp doctor` to discover the active URL.
5. If the health check succeeds, confirm `projectRoot` matches the selected workspace. If it points at a different workspace, ask the user whether to stop the existing Canary Lab server before continuing.
6. If the health check fails, start `npx canary-lab ui` from the selected workspace in a visible long-running terminal when the host supports that. The port comes from `canary-lab.config.json` (default `7421`); do not pass `--port` (it was removed).

## Flight (end-to-end pipeline)

1. `start_flight(repoPaths, description)` runs ONE background pipeline from bare repo(s) to a green, covered, healed run ending in an evaluation export (similarity → scout → scaffold → env → docs → PRD → specs↔coverage → portify → run → heal → export). The server conducts every stage and computes every verdict — you only approve checkpoints; do not run the stages yourself or start a separate run/coverage pass alongside an active flight.
2. Follow with `get_flight(flightId)` and do what its `next:` field says. On `waiting-for-approval`, call `respond_flight_checkpoint(flightId)` with `choice` (one of `checkpoint.options`), `values` (a missing-env KEY→value map), or `data` (`{ configSource }` for config-approval). A checkpoint payload over the inline budget is omitted from the tool result — review it in the web UI flight view, then respond here.
3. At a `prd-source` checkpoint, FIRST distill any requirements from this conversation with `write_feature_doc` (dropped docs win the source hierarchy), then respond.
4. ONE flight record per feature — never a silent second manifest. Re-calling `start_flight` follows an active flight and resumes a paused one from its first open stage; a settled one requires `redo: true` (restart from stage 1, discarding its stage evidence) or `from_stage: "<stage>"` (jump to a chosen stage — prerequisites are checked and a rejection names the missing artifact, e.g. no specs yet). The CLI equivalents are `--redo` and `--from-stage <key>`. `yolo: true` skips every checkpoint except missing env secrets.
5. On `done`, `links.evaluationZip` is the deliverable — point the user at opening the evaluation export (video playback where the tests drive a browser, plus the per-test reasoning in `evaluation.html`) as their immediate next step. Reviewing that export IS the core Canary Lab loop, not an optional extra.

The same flight is drivable from the CLI (`npx canary-lab flight <repo...> "<what to test>"`), the web UI (Flights pill), and this MCP surface — all against one store, so progress and checkpoints stay in sync everywhere.

## Guardrails

- Keep the same `session_id` for the whole conversation.
- The flight conducts run/heal/coverage/portify itself. While a flight is active, do not drive those stages with the focused skills — answer the flight's checkpoints instead.
- For one capability on its own (a run, a coverage pass, an export), use the matching focused skill: `canary-lab-run`, `canary-lab-verify`, `canary-lab-author`, `canary-lab-coverage`, `canary-lab-portify`, `canary-lab-export`.
