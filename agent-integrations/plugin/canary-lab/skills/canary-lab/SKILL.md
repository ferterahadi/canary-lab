---
name: canary-lab
description: Use when the user wants Canary Lab to take a product repo end to end — "test this app", "onboard this repo", "run a flight", "evaluate what I just built" — through the flight pipeline (start_flight / get_flight / respond_flight_checkpoint over MCP). One conducted pipeline goes from bare repo(s) to a green, covered, healed run and publishes a downloadable Report; final Parallel setup continues as Canary-owned background work. For a single capability use the focused skills instead — canary-lab-run (run + heal), canary-lab-verify (deployed-env verification), canary-lab-author (create feature + specs), canary-lab-coverage (PRD summary + coverage ledger), canary-lab-portify (concurrency-readiness), canary-lab-export (evaluation export).
type: skill
---

# Canary Lab — Flight

## MCP Invocation

Setup and the plugin expose one public Canary Lab MCP tool: `exec` (usually
rendered as `mcp__Canary_Lab__exec`). Every
Canary Lab tool name below is the exact `command` value, not a separate public
tool. For a feature-scoped command, replace both placeholders in this shape:

```json
{"command":"<exact_tool_name>","arguments":{"feature":"<feature_name>"}}
```

This is the envelope shape, not every command's complete schema. Add the
fields that command declares inside `arguments`; call `describe_tool` when a
field is uncertain.

Never invent a wrapper verb such as `learn` or `call`, embed JSON in a command
string, or turn arguments into flags. Keep fields such as `confirm: true` inside
`arguments`. Use `list_tools`, `search_tools`, or `describe_tool` as the
`command` when discovery is needed. A deliberately selected focused or `full`
profile still exposes atomic tools for debugging; the setup-installed path is
`compact` + `exec`.

The server computes every stage verdict. **Start the flight with `stage_producer:
"external"`** — the default for any MCP caller, so you get it even without passing it — so this client does every THINKING
step: scout, docs, PRD summary, spec and coverage authoring and mapping,
run healing, and localized evaluation export. The server still handles similarity,
scaffolding, environment capture, the test run, and final Parallel setup. Pass `stage_producer: "internal"`
instead only when the user wants a hands-off flight, or when this client cannot do the
work (no file tools, no subagents, permission refused) — and note a single step can
degrade on its own by answering `run-internally` on its checkpoint, so a whole flight
rarely needs to be internal. See *Doing the stage work yourself* below. The flight is Canary Lab's
front door: one command/tool takes
one or more bare product repos to a green, healed, covered run that ends in
an evaluation export. These tools arrive via the Canary Lab MCP server. If
this client is already connected (the plugin connects with `compact`), skip
this step. To configure the same connection manually: `npx canary-lab mcp
--profile compact`.

## Workspace Bootstrap

Before calling Canary Lab MCP tools, make sure the workspace and UI server are available.

1. Find the LIVE server first: read `~/.canary-lab/active-servers.json`. It records `projectRoot`, `port` and `pid` for every UI that registered. A stopped server's entry LINGERS — the file is only rewritten when the next server registers — so an entry is a candidate, not proof: the health check in step 4 is what confirms it. One entry → that is your server and its `port`; several → take the one whose `projectRoot` is the workspace the user means. Do NOT start from a guessed port.
2. Only when nothing live serves the workspace you want, fall back to the user-level registry at `~/.canary-lab/workspaces.json` (Windows: resolve from the home directory, e.g. `%USERPROFILE%\.canary-lab\workspaces.json`). Exactly one workspace → use it. Multiple → ask which, listing each `name` and `path`.
3. If the registry is missing or empty, ask the user to run `npx canary-lab setup` from the Canary Lab workspace.
4. Check the MCP health endpoint on the port you found in step 1. Only if no live entry gave you one, read `port` from the workspace's `canary-lab.config.json` (fallback `7421`). Then `curl -s http://127.0.0.1:<port>/mcp/health` — success is a JSON response. If it does not respond, run `npx canary-lab mcp doctor` to discover the active URL.
5. A healthy response does **not** settle the question on its own — VERIFY `projectRoot` against the workspace you intended. A stale UI left behind by a demo or a tarball smoke test answers a port just as convincingly as the right one, and that is exactly how a flight ends up running in someone's throwaway workspace instead of theirs. `projectRoot` matches → continue, and tell the user which workspace you are in. It names a DIFFERENT workspace → this is the wrong server: go back to step 1, do not adopt it. It is under a temp directory (`/tmp`, `/private/var/folders`, `%TEMP%`) → never auto-select it; those are throwaway demo workspaces that vanish, so use one only when the user names it explicitly. Only when the user wants a workspace no live server is serving does anything need starting or stopping.
6. If the health check fails, start `npx canary-lab ui` from the selected workspace in a visible long-running terminal when the host supports that; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up. The port comes from `canary-lab.config.json` (default `7421`); do not pass `--port` (it was removed).
7. Resolve this skill's ARGUMENTS against that workspace before calling any tool. A bare name — `flight-app` — is a directory in the workspace root (`<workspace>/flight-app`); it is not a suite name and not a repo to hunt for elsewhere on the machine. The Getting Started guide emits exactly that shape, with the intent string quoted beside it, so pass the resolved path as `repoPaths` and that string as `description`. An absolute path is used as given. If the named directory is not in the workspace, say so and ask — never substitute a similarly-named repo from somewhere else, and never invent the intent.
8. A healthy `/mcp/health` means the server is live. On the setup-installed `compact` profile, atomic names such as `get_feature_coverage` are deliberately absent from `tools/list`; only `exec` is public. Call `exec` with `{"command":"list_tools","arguments":{}}` before concluding the connection is missing. Only an unknown-tool error for `exec` means this session is not connected — ask the user to run `npx canary-lab setup --force` and reconnect/restart the client, then retry. Never drive `/mcp` with a hand-written HTTP/JSON-RPC client (curl included; the health check above is the only direct HTTP use): a custom client bypasses client detection and reconnect handling.

## Flight (end-to-end pipeline)

If `start_flight` returns `type: "getting_started_busy"`, a Getting Started demo already owns the workspace. Follow the returned active target (a run, Flight, coverage job, draft, portify, or export) in its current owner; do not start another workflow.

1. `start_flight(repoPaths, description)` runs ONE background pipeline from bare repo(s) to a green, covered, healed run that publishes a downloadable Report before final Parallel setup (similarity → scout → scaffold → env → docs → PRD → Tests & coverage → Test run → Auto-repair → Report → Parallel setup). Large apps therefore produce both harness evidence and the Report without first waiting for port-injection work. Report completion ends the foreground user journey: as soon as `get_flight` exposes `links.evaluationZip`, tell the user and end your turn while Canary continues Parallel setup as persistent background work. The server conducts every stage and computes every verdict — you only approve checkpoints; do not run the stages yourself or start a separate run/coverage pass alongside an active flight. A flight started with `stage_producer: "external"` — the default for any MCP caller, so you get it even without passing it — instead asks you to execute the thinking steps — scout / docs / prd-summary / specs↔coverage / the run's heal loop / a localized export — in-band via `external-work` checkpoints (see *Doing the stage work yourself*). Pass a stable `session_id` and useful `conversation_name` so the UI identifies this external agent session; use the client's real session id when available. Pass `external_session_url` only when it opens this exact conversation. Do not pass `client_kind` — the MCP bridge detects Claude/Codex from the connection.
2. Follow with `get_flight(flightId)` and do what its `next:` field says. On `waiting-for-approval`, call `respond_flight_checkpoint(flightId)` with `choice` (one of `checkpoint.options`), `values` (a missing-env KEY→value map), or `data` (`{ configSource }` for config-approval — the feature is already scaffolded, so this writes through to its REAL on-disk feature.config.cjs; `redraft` re-runs the repo scan). Under autopilot (the default) the terminal `export-mode` checkpoint answers itself — `raw` for an internal flight, `localized` for one started with `stage_producer: "external"` (the rewrite is thinking, so an external flight does it externally by default; the localized rewrite then arrives as an `external-work` hand-off). A flight started with `autopilot: false` parks there to pick `raw` (fast report) vs `localized` (agent-rewritten reasoning) either way. A checkpoint payload over the inline budget is omitted from the tool result — review it in the web UI flight view, then respond here. An `external-work` payload is the exception: it degrades to `promptPath` (plus `promptOmitted: true`) rather than being dropped, because the payload IS the task — `Read` that file for the full prompt.
3. Autopilot is ON by default: checkpoints with a safe default answer themselves (config-approval→approve, prd-source→continue when requirement docs already exist and collect-repo-docs when none do, coverage-stuck→accept-partial, portify-gate→run, portify-apply→apply, run-failed→export-as-is, export-mode→raw — or localized when the flight's stage producer is external), each logged `[autopilot]` on its stage. The flight still parks on `similarity-choice` and `missing-env` (no safe default) and on any RE-parked checkpoint — including a `prd-source` whose collector came back empty. A stage you explicitly RE-ENTER (`from_stage` / `redo`) always parks its FIRST checkpoint even under autopilot — choosing to re-run a step IS the intent to answer it differently. Start with `autopilot: false` when you plan to distill THIS conversation into requirement docs at the `prd-source` stop: add them with `write_feature_doc` — distilled from this conversation (`content`) or linking a local file (`link_path`, symlinked so the user's original stays live) — then respond `continue`. Write the docs FIRST: `continue` only appears in `checkpoint.options` once requirement docs exist on disk, so answering it on a doc-less park is rejected rather than accepted empty. Or have Canary's agent gather the docs guided by the flight's frozen intent: respond `collect-repo-docs` (copies in repo docs relevant to the intent) or `infer-from-diff` (derives requirements from the branch diff vs base) — an optional `feedback` string on respond_flight_checkpoint rides a retry into the agent's prompt. If the checkpoint's `data.lastAttempt` is present, a previous gather already came back EMPTY (`outcome`: `empty` | `no-output` | `no-diff`, with the agent's own `reason`) — do NOT simply repeat that same choice; the material is not in these repos. Supply the docs yourself, or re-run the agent only with `feedback` naming what it missed, or after the user points the flight at different repos. A parked `portify-gate` is the final Parallel setup ask after Report and BEFORE any Portify agent/double-boot cost: `run` starts the portify workflow (a sibling feature's saved overlay for the same app is reused and verified first — the agent only runs if that fails), `skip` keeps the feature serial and the flight continues. A parked `portify-apply` is a verified-diff review: `apply` saves the overlay (nothing lands in the product repos — runs apply it into throwaway per-run worktrees), `revise` REQUIRES `feedback: "<what to change>"` and re-runs the agent + double-boot re-verify (the checkpoint re-parks with the new diff), `cancel` discards the edits and SKIPS the stage — the flight continues without Parallel setup (the feature stays serial; a later flight can retry).
4. ONE flight record per feature — never a silent second manifest. Re-calling `start_flight` follows an active flight and resumes a paused one from its first open stage; a settled one requires `redo: true` (restart from stage 1) or `from_stage: "<stage>"` (jump to a chosen stage — prerequisites are checked and a rejection names the missing artifact, e.g. no specs yet). **A restart normally WIPES** the re-entered step and every later record step to zero on disk — requirement docs (user-added files and links included), authored specs, captured envsets, the portify overlay, the run record, the evaluation export — as if those steps never ran. The exception is `from_stage: "portify"`: Parallel setup resets only its own attempt and preserves the completed run, verdict, and downloadable Report. Plain resume (no flag) never wipes; warn the user before any other `redo`/`from_stage` when they may still want a step's artifacts. The CLI equivalents are `--redo` and `--from-stage <key>`. `fresh: true` skips resuming a paused flight and starts over instead. `yolo: true` skips every checkpoint except missing env secrets (export defaults to raw — localized, delivered as an `external-work` hand-off, when the stage producer is external: yolo skips asks, never work delivery); `autopilot: false` parks at every checkpoint instead of self-answering the safe ones. `agent: "claude" | "codex"` picks which CLI conducts the flight's stage agents — sticky per record (jump/continue reuse the stored one; only `redo: true` may change it; the run stage's auto-heal follows the workspace heal setting instead).
5. A flight's **repos and intent are frozen against MID-PIPELINE re-entry**. On `from_stage` / resume, **OMIT `repoPaths` and `description`** — the stored values are reused; passing DIFFERENT ones is rejected with `type: "flight_frozen"`. A full restart (`redo: true`) discards every stage's evidence and artifacts, so THERE new values are accepted: pass new `repoPaths`/`description` to start fresh and they replace the stored ones (omit them to reuse). Deleting a flight (web UI only — no tool or CLI flag) remains for removing the record itself, not for changing inputs. Whenever you re-enter a stage BECAUSE something was wrong, pass `feedback: "<what went wrong>"` alongside `redo`/`from_stage` — it is appended to the ENTRY stage's agent prompt. Without it the re-run has no idea the last attempt was rejected and produces the same thing again.
6. A flight parked `status: "paused"`, `pauseReason: "queued"` is **waiting its turn** behind another flight on the same repo(s) (a broad intent split into per-feature flights runs them sequentially). It **starts automatically** when that repo frees — narrate it as queued, not stuck, and do NOT ask the user to resume it. Only if they want it started early, re-calling `start_flight` resumes it now. (`stage-failed` and `restart` are the pauses a re-call picks up. `pauseReason: "user"` is different in kind: the user pressed Stop and Canary stopped that flight's live work — spawned agents, its run, a portify workflow, an export. Do NOT resume it unprompted; report it as stopped and let them ask. If you were mid `external-work` for it, discard that result rather than submitting it.)
7. **When the user says stop, stop it — do not just stop polling.** `pause_flight(flightId)` is the resumable stop: it ends the flight's live work (the stage's spawned agent, its test run including a repair in progress, a portify workflow, an export) and returns only once that work is actually stopped, keeping every stage's evidence — a later `start_flight` on the same repos resumes from the first open stage. `abort_flight(flightId, confirm: true)` is terminal: same teardown, no resume, and a queued sibling on the same repo(s) may start once the repos free. Prefer pause unless they want the flight abandoned. A verified portify review awaiting an answer survives a pause deliberately. Abandoning a flight by simply ceasing to `get_flight` leaves the whole pipeline running. `stop_flight_agent(flightId, confirm: true)` is the narrow option: it kills only the agent the CURRENT stage is running. Be honest with the user about what that does — the flight is waiting on that stage, so the attempt FAILS and the flight parks `stage-failed`; it does not carry on. What it buys over a pause is that the test run and the export are left alone, the stage keeps its error instead of resetting to not-started, and a queued sibling flight on the same repo(s) is released. Reach for it when one agent is misbehaving and everything else should stay up; reach for `pause_flight` when the user wants the flight held.
8. As soon as `links.evaluationZip` appears — including while status is still `running` on Parallel setup — point the user at opening the Report (video playback where the tests drive a browser, plus the per-test reasoning in `evaluation.html`) and end your turn. Reviewing that export IS the core Canary Lab loop, not an optional extra. Canary owns final Parallel setup as persistent background work; do not keep polling merely to hold the conversation open. The Flight page stays live, and a later `get_flight` can check it when the user asks.

A flight can be STARTED from the CLI (`npx canary-lab flight <repo...> "<what to test>"`), the web UI (Flights pill), or this MCP surface — one store, so progress shows everywhere. But a flight is driven by whoever started it: one you start over MCP defaults to `stage_producer: "external"`, and the web UI is then **read-only** for it. Its Respond, Pause, Continue and autopilot controls are disabled and point back at you; Abort stays live for when this session dies. During an `external-work` hand-off the UI also offers **Request takeover**: that does not race you with a local agent — it records the request and waits for you to release this one step. So never tell the user to answer, pause, or resume from the UI; the takeover handshake is the one supported transfer.

## Doing the stage work yourself

Only relevant when the flight was started with `stage_producer: "external"`
(sticky per record, like `agent`; a GUI-started flight is always internal
because there is no client to hand work to). Six steps then park on an
`external-work` checkpoint instead of spawning Canary's own CLI: **scout**
(survey the repos, draft the feature config), **docs** (gather or infer the
requirement docs — ask the user first; see the docs bullet below), **prd-summary** (distill the docs into testable
requirements), **specs↔coverage** (author the spec files, then map them
onto the requirements — two sequential hand-offs per authoring pass: the
mapping park asks for `{ mappings[], unmappable[] }` and every test in its
pinned roster must appear in one of them, exactly like
`submit_external_coverage`), **run/heal** (the flight
starts the run in external-heal mode UNCLAIMED and parks: `claim_heal` with
your OWN session id, loop `wait_for_heal_task`, fix APP code — never weaken a
test — `signal_run` after each fix, and respond `submit` once the run is
terminal; a failed run is a valid terminal answer and Canary reads the verdict
from the run record itself — never `abort_run` to escape), and
**evaluation-export**
(only when the mode is `localized` — the default for an external flight;
answer with `{ slots: [...] }` or the full `{ cases: [...] }` envelope the
prompt describes, and Canary renders the final evaluation.html itself, status
preserved).

- `checkpoint.data.prompt` is the task, rendered exactly as Canary's own agent
  would have received it — fan-out rule included. Split the reading across your
  own subagents where the prompt says to. If the payload was oversized, `Read`
  `checkpoint.data.promptPath` instead.
- A Flight created before Parallel setup became server-owned may still expose
  `external-work` with `checkpoint.data.stage: "portify"` after its Report
  exists. Do not perform that legacy hand-off. Release it immediately with
  `choice: "run-internally"`, tell the user where `links.evaluationZip` is,
  and end your turn while Canary continues it in the background.
- **The `docs` hand-off: ask the user BEFORE gathering.** The prompt asks you to
  search the repos (or read the diff), but the user may already hold the
  requirements. Ask first — "do you have a PRD/spec to give me (paste it, or
  point me at a local file), or should I gather from the repos by intent /
  infer from the branch diff?" — and never invent a document. If they supply
  material, do not gather: write their content (or a faithful distillation of
  their file) to `checkpoint.data.context.outPath` and submit — or, when they
  want their original file kept live, `write_feature_doc` with `link_path` and
  then submit; the step re-parks as `prd-source` with the linked doc counted,
  so answer `continue` there. Skip the ask only when the user already chose a
  gather path at a `prd-source` park in this conversation, or told you to
  proceed without them.
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
- **A takeover request means stop and release, never submit.** If a re-check
  carries `checkpoint.data.takeoverRequestedAt`, or a submit returns
  `type: "takeover_requested"`, stop this work plus any subagents/processes you
  started. Tell the user which files you already changed if they need to review
  them, then acknowledge with
  `respond_flight_checkpoint(flightId, choice: "run-internally")`. Canary starts
  its local agent only after that acknowledgement. The UI can force takeover if
  this session is gone; a later response from you is then rejected.
- **A parked hand-off has no deadline — so do NOT end your turn while one is open.** The flight advances only when you submit: nothing polls it, no timeout rescues it, and a status update to the user is not progress. Keep working through the submit, then follow the flight to its next stage. A read that finds a hand-off with no client contact for 45+ minutes carries `handOffIdle` — that is a step somebody took and abandoned; it is still answerable against the same `handOffId`, so pick it up or tell the user the flight is stalled. If you must stop, say so in the same breath and tell them the flight stays parked until they re-invoke this skill.
- A `type: "flight_stopped"` result means the flight is no longer waiting on you.
  Discard what you were about to submit, do not retry it, and do not resume the
  flight yourself — say it was stopped and let the user decide. Files you already
  wrote stay on disk; if they resume, a fresh hand-off arrives with a new id.
- **Canary re-validates independently, and its check is the verdict** — the
  drafted config must parse, the requirement doc must exist on disk, the
  submitted requirements are reconciled and re-read from the written summary, the specs
  must compile, and a mapping must account for every roster test before Canary's own
  tag-writer writes the tags and recomputes the ledger. Reporting success for work
  that did not land on disk re-parks or fails the stage; it never passes. This is
  the same bar Canary's own agent is held to, so there is nothing extra asked of
  you here.
- Can't do a step — no file tools, permission refused, wrong machine? Answer
  `choice: "run-internally"` and Canary's local agent takes **that one step**.
  The flight continues either way; nothing is lost.
- The server-owned stages (similarity, scaffold, env, the run's own Playwright
  execution, a `raw` export, and final Parallel setup) stay Canary's. Under an
  external flight only the heal loop is driven with the `canary-lab-run` tools
  FROM the flight's own hand-off checkpoint.

## Follow loop

Until the Report exists, re-call `get_flight(flightId)` while `status` is
`running` (wait ~20s between calls). Once `links.evaluationZip` appears,
surface it and end the foreground turn; final Parallel setup no longer needs
this conversation held open. Before then, stop states are `done`, `failed`,
`paused` (when `pauseReason` is not `queued`). On `waiting-for-approval`,
respond to the checkpoint instead of waiting.

| Status | Action |
| --- | --- |
| `running` + `links.evaluationZip` | Tell the user the Report is ready, explain Parallel setup continues in Canary's background, and end your turn. Do not poll merely to hold it open. |
| `running` | Wait ~20s, re-call `get_flight`. |
| `waiting-for-approval` | Respond via `respond_flight_checkpoint`. |
| `waiting-for-approval` + `checkpoint.data.takeoverRequestedAt` | Stop external work and release with `choice: "run-internally"`; do not submit. |
| `paused`, `pauseReason: "queued"` | Narrate as waiting — do NOT resume it. |
| `paused`, other `pauseReason` | Re-call `start_flight` (OMIT `repoPaths` + `description`) to resume. |
| `paused` + `remedy` in the result | A stage is blocked by uncommitted repo changes. Help the user clean each listed repo — `git stash push -u` (undoable) or commit — then `start_flight` resumes and the stage retries. |
| `done` | Point the user at `links.evaluationZip`. |
| `failed` | Report the failure; a re-call to `start_flight` resumes from the failed stage. |

## Guardrails

- **On `from_stage` / resume: OMIT `repoPaths` and `description`** — frozen against mid-pipeline re-entry. On `redo: true` you MAY pass new ones: a full restart replaces the stored inputs. Both `redo` and `from_stage` wipe the re-entered steps' on-disk artifacts (user-added docs included) — resume never does.
- `start_flight` accepts `session_id`, `conversation_name`, and `external_session_url` for Activity provenance. Keep the same values on resume/redo/jump. The other Flight tools do not take them.
- The flight conducts run/heal/coverage/portify itself. While a flight is active, do not drive those stages with the focused skills — answer the flight's checkpoints instead.
- For one capability on its own (a run, a coverage pass, an export), use the matching focused skill: `canary-lab-run`, `canary-lab-verify`, `canary-lab-author`, `canary-lab-coverage`, `canary-lab-portify`, `canary-lab-export`.
