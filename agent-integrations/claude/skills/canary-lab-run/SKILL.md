---
name: canary-lab-run
description: Use when running or healing an EXISTING Canary Lab feature locally — "run <feature>", "fix the failing run", "rerun 7cvh", "drive the heal loop" — through the repair MCP tools (start_run, wait_for_heal_task, signal_run, get_heal_context, pause_run, cancel_heal, abort_run). Fix failing runs by editing app/service code, not tests. For end-to-end onboarding of a new repo use canary-lab (flight); for deployed-environment checks use canary-lab-verify.
type: skill
---

# Canary Lab — Run + Heal Loop

Canary Lab owns the run verdicts and artifacts; this client applies the
fixes. These tools arrive via the Canary Lab MCP server. If this client is
already connected (the plugin connects with `full`), skip this step. To
configure a connection manually: `npx canary-lab mcp --profile repair` (the
composite `lifecycle`/`full` profiles carry the same tools).

## Arguments

An invocation argument (`/canary-lab-run <suite>` — the Getting Started
guide's "Repair a Broken Suite" card emits exactly this shape) is a suite
(feature) name in the connected workspace: pass it to `start_run` directly.

## Workspace Bootstrap

1. Find the LIVE server first: read `~/.canary-lab/active-servers.json`, which records `projectRoot`, `port` and `pid` for every UI that registered. A stopped server's entry LINGERS — the file is only rewritten when the next server registers — so an entry is a candidate, not proof: the health check below is what confirms it. One entry → that is your server and its `port`. Several → take the one whose `projectRoot` is the workspace the user means. None → fall back to `~/.canary-lab/workspaces.json` (Windows: `%USERPROFILE%\.canary-lab\workspaces.json`): one workspace → use it, several → ask which, none → ask the user to run `npx canary-lab setup`. Do NOT start from a guessed port.
2. Then CONFIRM it is the right server: `curl -s http://127.0.0.1:<port>/mcp/health` and check that `projectRoot` is the workspace you intended. A healthy response does **not** settle the question on its own — a stale UI left behind by a demo or a tarball smoke test answers a port just as convincingly as the right one, and that is how a flight ends up running in someone's throwaway workspace. `projectRoot` matches what you intended → continue and tell the user which workspace. It names a DIFFERENT workspace → this is the wrong server; go back to step 1 rather than adopting it. It is under a temp directory (`/tmp`, `/private/var/folders`, `%TEMP%`) → never auto-select it; those are throwaway demo workspaces, so use one only when the user names it explicitly. Only when no live server serves the workspace you want does one need starting.
3. If the health check fails, start `npx canary-lab ui` from the workspace in a visible long-running terminal; if this client cannot run long-lived commands, ask the user to run `npx canary-lab ui` from the workspace and confirm when it's up.
4. A healthy `/mcp/health` means the run tools are live even when they look absent from this session. If the Canary Lab MCP tools seem missing — e.g. a tool search returns no `start_run` match — they are usually **already loaded**: searches that index only deferred tools say nothing about loaded ones. Call `list_features` directly before concluding anything. Only if that call errors as an unknown tool is the server really not connected — ask the user to connect it (`npx canary-lab mcp --profile repair`, or reconnect this client's MCP integration), then retry. Never drive `/mcp` with a hand-written HTTP/JSON-RPC client (curl included; the health check above is the only direct HTTP use): a hand-rolled client bypasses the connection's client detection, so the Canary Lab UI mis-brands the heal session, and it loses the session and reconnect handling the run loop relies on.

## External Run Loop

If `start_run` returns `type: "getting_started_busy"`, a Getting Started demo already owns the workspace. Follow the returned active run or Flight in its current owner; do not start another.

1. Call `list_features` and choose the requested feature.
2. Call `start_run` with `claim_heal: true`, a stable `session_id`, and a useful `conversation_name`. Do **not** pass `client_kind` — the MCP bridge auto-detects it from the connection; guessing it yourself can mis-set it and suppress heal claim. Heal claiming is open to interactive Claude/Codex clients (Desktop or CLI alike) — only runner-spawned PTY agents are blocked — so an ordinary CLI session like this one can own the heal loop. For requests like "rerun 7cvh", pass `run_ref: "7cvh"`.
3. If `start_run` returns `type: "repo_collision_requires_choice"`, another run is using the same app/repo. Ask the user whether to run this one isolated in a per-run git worktree (runs now, concurrently) or queue it until the other run finishes, then re-call `start_run` with `isolation: "worktree"` or `isolation: "queue"`. Do not guess. If `start_run` returns `queued: true`, tell the user the run is parked (`queueReason`) and will start automatically when capacity frees; `wait_for_heal_task` still blocks until it starts and needs fixes.
4. If `start_run` returns an active run, continue that run. But if it returns `type: "boot_session"` (or `executionType: "boot"`), the run is a held boot-only session — services are up, no tests run, and there is no heal task. Do not claim heal or call `wait_for_heal_task`; report that services are ready and that the user can stop them with `abort_run` (confirm:true) when done. A service that fails its readiness probe is marked failed (its status shows `timeout`) but the session stays held — boot never self-aborts on a health-check failure, so report which services came up and which failed; only `abort_run` tears it down.
5. If `start_run` reports `already-claimed`, stop and tell the user which session owns the run. If it returns `claimSuppressed: true`, this session is a runner-spawned PTY agent (the benchmark/portify sessions Canary Lab launches itself) and cannot own the heal loop — interactive clients are *not* suppressed, so you normally won't hit this. The run still runs in External-client heal mode (it does **not** fall back to the project's configured heal agent — it waits for a drive); do not call `wait_for_heal_task`. Report the run id and tell the user to drive heal from an interactive Claude/Codex client or the web UI.
6. Handle user interrupts explicitly: "pause", "intercept", or "pause and heal" means call `pause_run`; "stop heal" or "cancel repair" means call `cancel_heal`; "abort", "kill the run", or "stop everything" means call `abort_run` only with the required confirmation.
7. Call `wait_for_heal_task` with the `runId` from `start_run` and the same `session_id`. It blocks for a short bounded window and heartbeats for you. If it returns `type: "still_waiting"`, the run is still active and the window just elapsed — this is **not** terminal: immediately call `wait_for_heal_task` again with the same `runId` + `session_id`. Loop on `still_waiting` until you get `needs_heal` / `passed` / `failed`. (If it ever returns `type: "boot_session"`, the run is a held boot-only session — report services are up and stop here; do not wait again.)
8. If it returns `passed`, summarize using `result.counts.statusLine` and stop.
9. If it returns `failed`, report the terminal status using `result.counts.statusLine` and relevant failure summary.
   - If the result carries `dirtyTests` (a test spec changed since the last green run — can appear on `passed`, `failed`, or `needs_heal`), relay `result.dirtyTests.message` to the user **verbatim** (e.g. "⚠️ Tests have been modified, please review.") alongside the outcome. Do **not** block, gate, re-run, revert, or edit the test files to "fix" it — it's an awareness signal so the user can review or commit the change, not an error to act on.
10. If it returns `needs_heal`, treat the returned heal context as the compact first-stop packet — which part of it matters depends on the situation:
    - **`context.failedTests` non-empty, first cycle** (`context.healPrompt` present): inspect `context.healPrompt.startHere` first, then use `context.healPrompt.resources`, current failures, and the checked-out source code. The packet is slim — `context.healIndex` and `context.journal` are **paths** (`Read` them when needed), and each `context.failedTests[]` entry carries a `failureId` plus pointer dirs (`errorPath`, `traceDir`, `playwrightMcpDir`).
    - **cycle ≥ 2** (`context.guidance` present, no `context.healPrompt`): `context.healPrompt` and `context.nextSteps` are sent on the **first** `needs_heal` only — on repeat cycles the context carries just the changed failure packet plus a `context.guidance` breadcrumb. Reuse the cycle-1 map, or call `get_heal_context` to re-fetch it.
    - **`context.escalation` present**: the **same** tests failed 3+ cycles running — you're stuck. Read `context.escalation.readFirst` and follow `context.escalation.tactics` (change tactic — revert or build on the prior diff, don't fire a fresh unrelated hypothesis) instead of repeating the last fix.
    - **`context.failedTests` empty AND `context.bootFailure` set**: a **service failed to boot** — no tests ran. `Read` `context.bootFailure.logPath` to find why the service won't serve, fix the service/app code, then `signal_run` `kind: "restart"` (`context.nextSteps` already reflects this).

    Call `get_run_snapshot` only when you need the verbose raw summary, full counts, or deeper debugging fields.
11. When **several** tests fail, fan out the diagnosis **and the fix-drafting**: dispatch one read-only sub-agent per failure in a single parallel round (up to 5 at once), hand each the `failureId`, and have it call `get_failure_detail(runId, failureId)` to investigate just that slice in parallel and report back a hypothesis **plus a concrete proposed patch** (the exact file edits / unified diff) for its failure. The sub-agents are read-only — they must **not** touch the working tree or call `signal_run`; they only investigate and draft. Then **you** apply the patches yourself, serially — reconcile by hand if two patches touch the same file — then re-test and `signal_run` once. Only investigation + drafting fan out; applying, re-testing, and signalling stay single-threaded. A sub-agent that comes back empty has **not** cleared its failure — say so in the hypothesis, or investigate that one yourself, rather than signalling as though its test were addressed. (For a single failure, just investigate and fix it directly.)
12. Fix app/service code, not tests, unless the test is provably wrong.
    - **Edit where the run actually booted.** When the heal context carries `context.worktrees` (repo name → path), this run is isolated and the services under test were booted from those per-run git worktrees — every **portified** feature runs this way, and so does any run the user isolated after a collision. Apply your fix under the `context.worktrees` path. `context.repoBranches[].path` is the **product** repo, which an isolated run never reads: patch only that and the rerun comes back byte-identical, which reads as "my fix did not work" when the fix was right and simply never loaded. The worktree edits are captured at teardown, so nothing is lost. When `context.worktrees` is absent, the run boots the repos in place and `repoBranches[].path` is the edit target.
13. Call `signal_run` **once** per cycle with `kind: "rerun"` for test-only/app-code fixes that do not need service restart, or `kind: "restart"` when services or env need restarting. Include `hypothesis` and `fixDescription`; Canary Lab writes the journal from that signal and its observed git diff. One accountable signal per cycle, even when you fixed several failures.
14. Do not call a separate journal-writing tool; the runner records failing tests, changed files, signal, outcome, and diff.
15. Repeat from `wait_for_heal_task` (looping on `still_waiting`) until the run passes or reaches terminal failure.

## `wait_for_heal_task` result types

| Result | Action |
| --- | --- |
| `still_waiting` | Not terminal — re-call with the same `runId` + `session_id`. |
| `needs_heal` | Fix (see step 10), `signal_run` once, then wait again. |
| `passed` | Report `result.counts.statusLine`, plus what happened to your fix (see below), then stop. |
| `failed` | Report `result.counts.statusLine` + failure summary, stop. |
| `boot_session` | Report which services came up, stop — never wait again. |

## What happens to your fix when the run passes

Your edits are never left only in your head or only on disk. At teardown Canary Lab diffs the
run's working copy, saves the result as a patch per repo, and — unless the workspace turned it
off — opens a **draft pull request** from it. So on `passed`:

- **Do not open a pull request yourself**, and do not push a branch. The run does it, on a branch
  named per feature + repo, so healing the same feature again updates that same pull request
  instead of opening a second one.
- Report what the run reports: the pull request URL when there is one, or the per-repo reason
  there isn't (gh not signed in, no push rights, the patch no longer applies). Both live on the
  run's `prAttempt`; the diff itself is on the run's **Changes** tab in the Canary Lab UI.
- A run that ends red, or that gives up after its cycle cap, opens nothing — a fix that didn't
  make the tests pass is not a fix to propose.

## Guardrails

- `session_id` recipe: generate one id at the start of the conversation (any unique string) and pass that identical value in every tool call for the rest of the conversation.
- A FLIGHT can hand you a run via an `external-work` checkpoint carrying a `runId`: the run was started in external-heal mode UNCLAIMED for you — `claim_heal` it with your own `session_id` and drive this exact loop, then release the flight with `respond_flight_checkpoint(flightId, choice: "submit")` once the run is terminal (a failed run is a valid terminal answer; Canary reads the verdict from the run record). Never `abort_run` a flight-owned run to escape it, and never start another run for that feature while the flight owns it. The flight will wait on you indefinitely — a parked hand-off has no deadline — so do not end your turn with it open; after 45 minutes with no `get_flight` contact the read reports `handOffIdle` on it.
- `heartbeat` is a low-level liveness refresh for long local repair stretches. `wait_for_heal_task` heartbeats while waiting, and `signal_run` and `get_heal_context` refresh liveness, so call explicit `heartbeat` only before or after a long stretch of local `Read` / `Edit` / `Write` / `Bash` work.
- `start_run` is the single entrypoint for start/resume/restart intent. With no `run_ref`/`force_new`, a healing run for the feature is continued by default. Concurrent runs are allowed: a same-app collision returns `repo_collision_requires_choice` (resolve with `isolation: "worktree"` or `"queue"`); over the resource budget, the run is `queued` and starts automatically.
- For requests like "rerun 7cvh", `start_run` resolves the run suffix and restarts that same failed/aborted run in remaining-test mode. Canary Lab reruns failed tests first, then skipped tests, then pending/not-run tests; do not tell the user no test filter exists.
- To re-execute a run, reuse it: prefer this rerun (`start_run` with `run_ref`) over `abort_run` + a fresh start — rerun re-executes only the failed/skipped/pending tests and avoids the abort + repo-collision dance. The rerun already re-runs skipped **and** pending tests, so it is complete — do **not** `force_new` just to avoid "skipped" tests. On a **portified** feature, `force_new` spins a brand-new per-run worktree and resets the heal journal to Iteration 1, discarding the prior cycles. Start a fresh full run only when prior passes are genuinely invalidated (e.g. a global data/state change), and you rarely need to `abort_run` first to do so.
- After changing code or tests, never call `start_run` to verify. Verification means `signal_run` with `hypothesis` and `fixDescription`, then `wait_for_heal_task` on the same `runId`.
- During normal healing, omit `run_ref`/`force_new` so `start_run` continues the healing run. Use `force_new` only when the user explicitly wants a separate concurrent run on the same feature (it resolves through the collision choice).
- Never compute passed count as `summary.total - summary.failed.length`. Use `result.counts.statusLine`, `result.counts.passed`, or `summary.passed` for pass counts. Treat tests absent from `passedNames`, `failed`, and `skippedNames` as not run, not passed.
- Do not call `abort_run` unless the user asks, and pass the required confirmation only for an explicit abort/kill/stop-everything request.
- Prefer compact `get_heal_context` when you need to refresh failure artifacts outside the wait loop. Use `get_run_snapshot` only for verbose fallback/debugging context.
- Read responses are slim by default to protect your context, but the full data is always one step away — pull it whenever a failure needs deeper detail (just never in a wait loop): `get_run` omits the raw `lifecycleEvents`/`playwrightArtifacts`/`playbackEvents` (call it again with `includeRaw:true` to inline them); `get_run_snapshot` returns the heal-index and journal as **paths** to `Read`; `list_runs` returns the newest 20 (raise `limit`).
- On any terminal run, point the user at the evaluation export as the next step (the `canary-lab-export` skill / `export` profile produces it).
- Record concise, factual journal notes. Do not paste raw transcripts.
- When the run is waiting for external heal, Canary Lab is the source of truth for status, artifacts, and rerun/restart signals.
