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
2. Follow with `get_flight(flightId)` and do what its `next:` field says. On `waiting-for-approval`, call `respond_flight_checkpoint(flightId)` with `choice` (one of `checkpoint.options`), `values` (a missing-env KEY→value map), or `data` (`{ configSource }` for config-approval — the feature is already scaffolded, so this writes through to its REAL on-disk feature.config.cjs; `redraft` re-runs the repo scan). Under autopilot (the default) the terminal `export-mode` checkpoint answers itself with `raw`; a flight started with `autopilot: false` parks there to pick `raw` (fast report) vs `localized` (agent-rewritten reasoning). A checkpoint payload over the inline budget is omitted from the tool result — review it in the web UI flight view, then respond here.
3. Autopilot is ON by default: checkpoints with a safe default answer themselves (config-approval→approve, prd-source→continue when requirement docs already exist, coverage-stuck→accept-partial, portify-gate→run, portify-apply→apply, run-failed→export-as-is, export-mode→raw), each logged `[autopilot]` on its stage. The flight still parks on `similarity-choice` and `missing-env` (no safe default), on `prd-source` when NO docs exist yet, and on any RE-parked checkpoint. A stage you explicitly RE-ENTER (`from_stage` / `redo`) always parks its FIRST checkpoint even under autopilot — choosing to re-run a step IS the intent to answer it differently. Start with `autopilot: false` when you plan to distill THIS conversation into requirement docs at the `prd-source` stop: add them with `write_feature_doc` — distilled from this conversation (`content`) or linking a local file (`link_path`, symlinked so the user's original stays live) — then respond `continue`. Or have Canary's agent gather the docs guided by the flight's frozen intent: respond `collect-repo-docs` (copies in repo docs relevant to the intent) or `infer-from-diff` (derives requirements from the branch diff vs base) — an optional `feedback` string on respond_flight_checkpoint rides a retry into the agent's prompt. If the checkpoint's `data.lastAttempt` is present, a previous gather already came back EMPTY (`outcome`: `empty` | `no-output` | `no-diff`, with the agent's own `reason`) — do NOT simply repeat that same choice; the material is not in these repos. Supply the docs yourself, or re-run the agent only with `feedback` naming what it missed, or after the user points the flight at different repos. A parked `portify-gate` is the upfront parallel-readiness ask BEFORE any agent/double-boot cost: `run` starts the portify workflow (a sibling feature's saved overlay for the same app is reused and verified first — the agent only runs if that fails), `skip` keeps the feature serial and the flight continues. A parked `portify-apply` is a verified-diff review: `apply` saves the overlay (nothing lands in the product repos — runs apply it into throwaway per-run worktrees), `revise` REQUIRES `feedback: "<what to change>"` and re-runs the agent + double-boot re-verify (the checkpoint re-parks with the new diff), `cancel` discards the edits and SKIPS the stage — the flight continues without parallel readiness (the feature stays serial; a later flight can retry).
4. ONE flight record per feature — never a silent second manifest. Re-calling `start_flight` follows an active flight and resumes a paused one from its first open stage; a settled one requires `redo: true` (restart from stage 1) or `from_stage: "<stage>"` (jump to a chosen stage — prerequisites are checked and a rejection names the missing artifact, e.g. no specs yet). **A restart WIPES**: the re-entered step and every later step are rewound to zero on disk — requirement docs (user-added files and links included), authored specs, captured envsets, the portify overlay, the run record, the evaluation export — as if those steps never ran. Plain resume (no flag) never wipes; warn the user before `redo`/`from_stage` when they may still want a step's artifacts. The CLI equivalents are `--redo` and `--from-stage <key>`. `fresh: true` skips resuming a paused flight and starts over instead. `yolo: true` skips every checkpoint except missing env secrets (export defaults to raw); `autopilot: false` parks at every checkpoint instead of self-answering the safe ones. `agent: "claude" | "codex"` picks which CLI conducts the flight's stage agents — sticky per record (jump/continue reuse the stored one; only `redo: true` may change it; the run stage's auto-heal follows the workspace heal setting instead).
5. A flight's **repos and intent are frozen against MID-PIPELINE re-entry**. On `from_stage` / resume, **OMIT `repoPaths` and `description`** — the stored values are reused; passing DIFFERENT ones is rejected with `type: "flight_frozen"`. A full restart (`redo: true`) discards every stage's evidence and artifacts, so THERE new values are accepted: pass new `repoPaths`/`description` to start fresh and they replace the stored ones (omit them to reuse). Deleting a flight (web UI only — no tool or CLI flag) remains for removing the record itself, not for changing inputs.
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
| `paused` + `remedy` in the result | A stage is blocked by uncommitted repo changes. Help the user clean each listed repo — `git stash push -u` (undoable) or commit — then `start_flight` resumes and the stage retries. |
| `done` | Point the user at `links.evaluationZip`. |
| `failed` | Report the failure; a re-call to `start_flight` resumes from the failed stage. |

## Guardrails

- **On `from_stage` / resume: OMIT `repoPaths` and `description`** — frozen against mid-pipeline re-entry. On `redo: true` you MAY pass new ones: a full restart replaces the stored inputs. Both `redo` and `from_stage` wipe the re-entered steps' on-disk artifacts (user-added docs included) — resume never does.
- Flight tools take no `session_id` (only tools that declare `session_id` in their schema take one; `start_flight` / `get_flight` / `respond_flight_checkpoint` do not).
- The flight conducts run/heal/coverage/portify itself. While a flight is active, do not drive those stages with the focused skills — answer the flight's checkpoints instead.
- For one capability on its own (a run, a coverage pass, an export), use the matching focused skill: `canary-lab-run`, `canary-lab-verify`, `canary-lab-author`, `canary-lab-coverage`, `canary-lab-portify`, `canary-lab-export`.
