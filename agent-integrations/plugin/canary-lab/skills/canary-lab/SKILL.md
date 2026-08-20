---
name: canary-lab
description: Use when the user wants Canary Lab to take a product repo end to end — "test this app", "onboard this repo", "run a flight", "evaluate what I just built" — through the flight pipeline (start_flight / get_flight / respond_flight_checkpoint over MCP). One conducted background pipeline goes from bare repo(s) to a green, covered, healed run ending in an evaluation export. For a single capability use the focused skills instead — canary-lab-run (run + heal), canary-lab-verify (deployed-env verification), canary-lab-author (create feature + specs), canary-lab-coverage (PRD summary + coverage ledger), canary-lab-portify (concurrency-readiness), canary-lab-export (evaluation export).
type: skill
---

# Canary Lab — Flight

The server computes every stage verdict. By DEFAULT this client only answers
checkpoints; start the flight with `stage_producer: "external"` and its three
hand-off-capable steps (scout, docs, specs↔coverage) come to you as work
instead — see *Doing the stage work yourself* below. The flight is Canary Lab's
front door: one command/tool takes
one or more bare product repos to a green, healed, covered run that ends in
an evaluation export. These tools arrive via the Canary Lab MCP server. If
this client is already connected (the plugin connects with `full`), skip
this step. To configure a connection manually: `npx canary-lab mcp --profile
flight` (the composite `lifecycle`/`full` profiles carry the same tools).

## Workspace Bootstrap

Before calling Canary Lab MCP tools, make sure the workspace and UI server are available.

1. Read the user-level registry at `~/.canary-lab/workspaces.json`. On Windows, resolve it from the user's home directory, for example `%USERPROFILE%\.canary-lab\workspaces.json`.
2. If the registry has exactly one workspace, use that workspace. If it has multiple, do NOT ask yet — step 5 usually settles it. Ask (listing each `name` and `path`) only when no server is running.
3. If the registry is missing or empty, ask the user to run `npx canary-lab setup` from the Canary Lab workspace.
4. Check the MCP health endpoint: read `port` from the workspace's `canary-lab.config.json` (fallback `7421`), then `curl -s http://127.0.0.1:<port>/mcp/health` — success is a JSON response. If it does not respond, run `npx canary-lab mcp doctor` to discover the active URL.
5. If the health check succeeds, `projectRoot` names the workspace that server actually serves — and one server serves one workspace, so this SETTLES the choice. Use `projectRoot`, tell the user which workspace you are in, and continue. A registry entry that disagrees is not a conflict to resolve, and a `projectRoot` under a temp directory is a legitimate demo workspace, not a stray to shut down. Only when the user explicitly wants a DIFFERENT workspace does this server need stopping first.
6. If the health check fails, start `npx canary-lab ui` from the selected workspace in a visible long-running terminal when the host supports that; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up. The port comes from `canary-lab.config.json` (default `7421`); do not pass `--port` (it was removed).
7. Resolve this skill's ARGUMENTS against that workspace before calling any tool. A bare name — `flight-app` — is a directory in the workspace root (`<workspace>/flight-app`); it is not a suite name and not a repo to hunt for elsewhere on the machine. The Getting Started guide emits exactly that shape, with the intent string quoted beside it, so pass the resolved path as `repoPaths` and that string as `description`. An absolute path is used as given. If the named directory is not in the workspace, say so and ask — never substitute a similarly-named repo from somewhere else, and never invent the intent.

## Flight (end-to-end pipeline)

If `start_flight` returns `type: "getting_started_busy"`, a Getting Started demo already owns the workspace. Follow the returned active run or Flight in its current owner; do not start another.

1. `start_flight(repoPaths, description)` runs ONE background pipeline from bare repo(s) to a green, covered, healed run ending in an evaluation export (similarity → scout → scaffold → env → docs → PRD → specs↔coverage → portify → run → heal → export). The server conducts every stage and computes every verdict — you only approve checkpoints; do not run the stages yourself or start a separate run/coverage pass alongside an active flight. The one exception is a flight you started with `stage_producer: "external"`, which asks you to execute scout / docs / specs↔coverage in-band via `external-work` checkpoints.
2. Follow with `get_flight(flightId)` and do what its `next:` field says. On `waiting-for-approval`, call `respond_flight_checkpoint(flightId)` with `choice` (one of `checkpoint.options`), `values` (a missing-env KEY→value map), or `data` (`{ configSource }` for config-approval — the feature is already scaffolded, so this writes through to its REAL on-disk feature.config.cjs; `redraft` re-runs the repo scan). Under autopilot (the default) the terminal `export-mode` checkpoint answers itself with `raw`; a flight started with `autopilot: false` parks there to pick `raw` (fast report) vs `localized` (agent-rewritten reasoning). A checkpoint payload over the inline budget is omitted from the tool result — review it in the web UI flight view, then respond here. An `external-work` payload is the exception: it degrades to `promptPath` (plus `promptOmitted: true`) rather than being dropped, because the payload IS the task — `Read` that file for the full prompt.
3. Autopilot is ON by default: checkpoints with a safe default answer themselves (config-approval→approve, prd-source→continue when requirement docs already exist and collect-repo-docs when none do, coverage-stuck→accept-partial, portify-gate→run, portify-apply→apply, run-failed→export-as-is, export-mode→raw), each logged `[autopilot]` on its stage. The flight still parks on `similarity-choice` and `missing-env` (no safe default) and on any RE-parked checkpoint — including a `prd-source` whose collector came back empty. A stage you explicitly RE-ENTER (`from_stage` / `redo`) always parks its FIRST checkpoint even under autopilot — choosing to re-run a step IS the intent to answer it differently. Start with `autopilot: false` when you plan to distill THIS conversation into requirement docs at the `prd-source` stop: add them with `write_feature_doc` — distilled from this conversation (`content`) or linking a local file (`link_path`, symlinked so the user's original stays live) — then respond `continue`. Or have Canary's agent gather the docs guided by the flight's frozen intent: respond `collect-repo-docs` (copies in repo docs relevant to the intent) or `infer-from-diff` (derives requirements from the branch diff vs base) — an optional `feedback` string on respond_flight_checkpoint rides a retry into the agent's prompt. If the checkpoint's `data.lastAttempt` is present, a previous gather already came back EMPTY (`outcome`: `empty` | `no-output` | `no-diff`, with the agent's own `reason`) — do NOT simply repeat that same choice; the material is not in these repos. Supply the docs yourself, or re-run the agent only with `feedback` naming what it missed, or after the user points the flight at different repos. A parked `portify-gate` is the upfront parallel-readiness ask BEFORE any agent/double-boot cost: `run` starts the portify workflow (a sibling feature's saved overlay for the same app is reused and verified first — the agent only runs if that fails), `skip` keeps the feature serial and the flight continues. A parked `portify-apply` is a verified-diff review: `apply` saves the overlay (nothing lands in the product repos — runs apply it into throwaway per-run worktrees), `revise` REQUIRES `feedback: "<what to change>"` and re-runs the agent + double-boot re-verify (the checkpoint re-parks with the new diff), `cancel` discards the edits and SKIPS the stage — the flight continues without parallel readiness (the feature stays serial; a later flight can retry).
4. ONE flight record per feature — never a silent second manifest. Re-calling `start_flight` follows an active flight and resumes a paused one from its first open stage; a settled one requires `redo: true` (restart from stage 1) or `from_stage: "<stage>"` (jump to a chosen stage — prerequisites are checked and a rejection names the missing artifact, e.g. no specs yet). **A restart WIPES**: the re-entered step and every later step are rewound to zero on disk — requirement docs (user-added files and links included), authored specs, captured envsets, the portify overlay, the run record, the evaluation export — as if those steps never ran. Plain resume (no flag) never wipes; warn the user before `redo`/`from_stage` when they may still want a step's artifacts. The CLI equivalents are `--redo` and `--from-stage <key>`. `fresh: true` skips resuming a paused flight and starts over instead. `yolo: true` skips every checkpoint except missing env secrets (export defaults to raw); `autopilot: false` parks at every checkpoint instead of self-answering the safe ones. `agent: "claude" | "codex"` picks which CLI conducts the flight's stage agents — sticky per record (jump/continue reuse the stored one; only `redo: true` may change it; the run stage's auto-heal follows the workspace heal setting instead).
5. A flight's **repos and intent are frozen against MID-PIPELINE re-entry**. On `from_stage` / resume, **OMIT `repoPaths` and `description`** — the stored values are reused; passing DIFFERENT ones is rejected with `type: "flight_frozen"`. A full restart (`redo: true`) discards every stage's evidence and artifacts, so THERE new values are accepted: pass new `repoPaths`/`description` to start fresh and they replace the stored ones (omit them to reuse). Deleting a flight (web UI only — no tool or CLI flag) remains for removing the record itself, not for changing inputs.
6. A flight parked `status: "paused"`, `pauseReason: "queued"` is **waiting its turn** behind another flight on the same repo(s) (a broad intent split into per-feature flights runs them sequentially). It **starts automatically** when that repo frees — narrate it as queued, not stuck, and do NOT ask the user to resume it. Only if they want it started early, re-calling `start_flight` resumes it now. (`stage-failed` and `restart` are the pauses a re-call picks up. `pauseReason: "user"` is different in kind: the user pressed Stop and Canary stopped that flight's live work — spawned agents, its run, a portify workflow, an export. Do NOT resume it unprompted; report it as stopped and let them ask. If you were mid `external-work` for it, discard that result rather than submitting it.)
7. **When the user says stop, stop it — do not just stop polling.** `pause_flight(flightId)` is the resumable stop: it ends the flight's live work (the stage's spawned agent, its test run including a repair in progress, a portify workflow, an export) and returns only once that work is actually stopped, keeping every stage's evidence — a later `start_flight` on the same repos resumes from the first open stage. `abort_flight(flightId, confirm: true)` is terminal: same teardown, no resume, and a queued sibling on the same repo(s) may start once the repos free. Prefer pause unless they want the flight abandoned. A verified portify review awaiting an answer survives a pause deliberately. Abandoning a flight by simply ceasing to `get_flight` leaves the whole pipeline running. `stop_flight_agent(flightId, confirm: true)` is the narrow option: it kills only the agent the CURRENT stage is running. Be honest with the user about what that does — the flight is waiting on that stage, so the attempt FAILS and the flight parks `stage-failed`; it does not carry on. What it buys over a pause is that the test run and the export are left alone, the stage keeps its error instead of resetting to not-started, and a queued sibling flight on the same repo(s) is released. Reach for it when one agent is misbehaving and everything else should stay up; reach for `pause_flight` when the user wants the flight held.
8. On `done`, `links.evaluationZip` is the deliverable — point the user at opening the evaluation export (video playback where the tests drive a browser, plus the per-test reasoning in `evaluation.html`) as their immediate next step. Reviewing that export IS the core Canary Lab loop, not an optional extra.

The same flight is drivable from the CLI (`npx canary-lab flight <repo...> "<what to test>"`), the web UI (Flights pill), and this MCP surface — all against one store, so progress and checkpoints stay in sync everywhere.

## Doing the stage work yourself

Only relevant when the flight was started with `stage_producer: "external"`
(sticky per record, like `agent`; a GUI-started flight is always internal
because there is no client to hand work to). Three steps then park on an
`external-work` checkpoint instead of spawning Canary's own CLI: **scout**
(survey the repos, draft the feature config), **docs** (gather or infer the
requirement docs), and **specs↔coverage** (author the spec files, once per
authoring pass).

- `checkpoint.data.prompt` is the task, rendered exactly as Canary's own agent
  would have received it — fan-out rule included. Split the reading across your
  own subagents where the prompt says to. If the payload was oversized, `Read`
  `checkpoint.data.promptPath` instead.
- Do the work with your own tools, writing to the real paths the prompt names.
  Then release it: `respond_flight_checkpoint(flightId, choice: "submit", data: <the shape the prompt asks for>, token: checkpoint.data.handOffId)`.
- **Pass `token`, and re-check before you submit.** `checkpoint.data.handOffId`
  identifies the hand-off you were given. These steps run for many minutes and
  nothing can interrupt you mid-turn, so re-call `get_flight(flightId)` between
  fan-out rounds, roughly every 10 minutes, and **always immediately before
  submitting**. If the status is no longer `waiting-for-approval`, or the
  `handOffId` has changed, the user stopped or re-asked this step: discard your
  result, do not submit, and tell them. A submit carrying a superseded id is
  discarded server-side and the step re-parks with
  `data.lastRejection: "stale_submission"` — work you did after that point was
  never going to count.
- A `type: "flight_stopped"` result means the flight is no longer waiting on you.
  Discard what you were about to submit, do not retry it, and do not resume the
  flight yourself — say it was stopped and let the user decide. Files you already
  wrote stay on disk; if they resume, a fresh hand-off arrives with a new id.
- **Canary re-validates independently, and its check is the verdict** — the
  drafted config must parse, the requirement doc must exist on disk, the specs
  must compile and raise the computed coverage ledger. Reporting success for work
  that did not land on disk re-parks or fails the stage; it never passes. This is
  the same bar Canary's own agent is held to, so there is nothing extra asked of
  you here.
- Can't do a step — no file tools, permission refused, wrong machine? Answer
  `choice: "run-internally"` and Canary's local agent takes **that one step**.
  The flight continues either way; nothing is lost.
- Every other stage (similarity, scaffold, env, portify, run, heal, export) is
  unaffected and stays Canary's. `portify` and the heal loop already have their
  own dedicated hand-offs — use `canary-lab-portify` / `canary-lab-run` for those.

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
