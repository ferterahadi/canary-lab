Canary Lab — external repair loop. Fix app/service code, not tests, unless a test is provably wrong; never delete, skip, weaken, or loosen an assertion to turn a run green.

1. start_run with claim_heal:true, one stable session_id, and conversation_name; never pass client_kind. For "rerun <id>" pass run_ref. A stale-coverage fresh start asks the USER update-first vs diagnostic run-now; never choose. Update-first starts nothing; run-now stays coverageStale. Special results — repo_collision_requires_choice: ASK worktree vs queue; queued:true: wait; boot_session: no heal task; getting_started_busy: follow its target.
2. wait_for_heal_task with the same runId + session_id. It BLOCKS for a bounded window; type:"still_waiting" is NOT terminal — call it again until needs_heal / passed / failed. Never poll get_run_snapshot or get_run in a loop.
3. On needs_heal follow context.nextSteps (read context.healPrompt.startHere first), fix it YOURSELF, then signal_run ONCE with hypothesis + fixDescription and wait again. The signal requests runner verification; it does not claim a pass. Do not start services or run Playwright or other runtime checks; Canary owns restart, health, and verification.

Read result.counts.statusLine / result.counts.passed, never total - failed (not-run is not a pass). Relay dirtyTests/specEdits VERBATIM once; never edit the test files to clear them. specEdits changed after start and were NOT tested: get_test_review → show patch → review_test_changes. The human chooses Accept & commit or Restore recorded files; cancel leaves pending. Acceptance commits the exact scope and returns a durable receipt, then an active run reruns or an ended run needs start_run without run_ref. No MCP tool can self-approve. The old verdict is preserved; a weaker hint → restore.

Full guide: get_workflow_guide(workflow:"repair").

<!-- initialize-cut -->
Details:

When a blocked start returns request_id, carry it through get_test_review and
review_test_changes. After human acceptance or restoration, resume with start_run
using request_id and the SAME session_id. The original external client owns that
continuation even if the user decides in the browser. Canary resumes internal
requests itself; never launch a replacement or transfer ownership implicitly.
get_test_review returns a read-only browser_wait_token for every client, including
clients with forms. Use it with wait_for_decision:true to observe a browser decision;
after reconnect obtain a fresh token and read the same durable request. Neither a
wait token nor an agent-written argument approves anything. A receipt proves the
review decision, not that the request started or the tests passed.

Envset values belong in `features/<feature>/envsets/<env>/<slot>` in the selected
workspace. A suite `.env` is a materialized consumer target, not a second source.
Never create pointer-only envsets or target `.runtime/envsets`, an envset source,
or a personal source checkout merely because an old variable points there.
For a user-authorized envset repair, read get_workflow_guide(workflow:"author")
and trace source → target → consumer before updating values and consumer together.
App-code repair permission alone does not authorize a suite migration.

wait_for_heal_task waits for pending signals to be consumed and for live runners to finalize before reporting terminal results. A transient failed test result can still lead into healing; keep the same run.

A matching active run is reused even with force_new:true. Intentional concurrent runs of the same feature start from the Run panel. For an ordinary failed/aborted rerun, start_run(run_ref) preserves its recorded suite and journal. Pending test review requires get_test_review then review_test_changes first. Accept & commit records exact human approval and the Git commit in one receipt: an active run adopts and reruns; an ended passed/failed/aborted run then needs start_run without run_ref. A clean tree or arbitrary commit is never approval. abort_run requires a human form response; confirm:true alone cannot stop anything. Clients without forms use Stop in the Run panel.

Declared canary:environments annotations are captured before execution. Only reporter-observed skipped tests outside the selected environment count as counts.notApplicable; they remain skipped, never passed. Ordinary skips and not-run tests still block completion. Do not add an exclusion to evade a failure; applicability edits require human test review.

1. start_run with claim_heal:true, a stable session_id reused for the whole conversation, and conversation_name. Do NOT pass client_kind — the MCP bridge auto-detects it from the connection; passing it yourself can mis-set it and suppress heal claim. Heal claiming is open to interactive Claude/Codex clients (Desktop or CLI); it is suppressed only for runner-spawned PTY agents Canary Lab launches itself. For "rerun <id>" pass run_ref (e.g. "7cvh").
   - Before a fresh run, stale test-to-requirement coverage opens a human choice: update coverage first, or run now with stale coverage. Never answer it yourself. Update-first returns type:"coverage_update_required" and starts nothing: respect activeJobId / flightId ownership, complete the coverage nextAction, confirm freshness, then retry start_run. Run-now may continue for diagnostics, but coverageStale:true means the old percentage remains historical. Decline/cancel starts nothing. Reusing an active run or restarting a failed/aborted run with run_ref continues its recorded suite without this gate.
   - A run boots the commit the repo checkout is on, not the branch's latest. Pass update_repos:true to fetch + fast-forward each pinned repo first (a repo with track:'upstream' in feature.config.cjs does this on every run; update_repos:false boots as-is). If start_run returns type:"repo_update_refused", nothing started: repos[] names each repo and why (dirty, diverged, detached, wrong-branch, fetch-failed, in-use). Tell the user; never stash, reset or discard their work to force it. Re-call start_run once reconciled, or with update_repos:false to boot the checked-out commit anyway.
   - If start_run returns type:"repo_collision_requires_choice", another run is using the same app/repo. ASK THE USER whether to run isolated (a per-run git worktree, concurrent) or queue until the other run finishes, then re-call start_run with isolation:"worktree" or isolation:"queue". Do not guess.
   - If start_run returns type:"getting_started_busy", a Getting Started demo already owns the workspace. Follow the active target it returns; do not start another run or Flight.
   - If start_run returns queued:true, the run is parked (queueReason tells you why) and will start automatically when capacity frees; wait_for_heal_task still works — it blocks until the run starts and needs fixes.
   - If start_run (or wait_for_heal_task) returns type:"boot_session" (executionType:"boot"), the run is a held boot-only session: services are up, no tests run, and there is NO heal task. Do not wait for heal — report that services are ready and that abort_run requests human stop approval. A service that fails its readiness probe is marked failed (its status shows "timeout") but the session stays held — boot never self-aborts on a health-check failure, so report which services came up and which failed; only abort_run tears it down.
2. wait_for_heal_task with the same runId + session_id. This BLOCKS for a short bounded window (and heartbeats for you) until the run needs fixes, passes, or fails. If it returns type:"still_waiting" the run is still active and the window simply elapsed — this is NOT terminal: immediately call wait_for_heal_task again with the same runId + session_id. Loop on still_waiting until you get needs_heal / passed / failed. Always wait this way — never poll get_run_snapshot or get_run in a loop.
3. On needs_heal the result is self-describing: follow context.nextSteps (read context.healPrompt.startHere first), apply all the fixes YOURSELF, then signal_run ONCE per cycle with hypothesis + fixDescription, and wait_for_heal_task again. The signal requests runner verification; it is not a claim that the fix already passes. Do not start services or run Playwright, smoke, end-to-end, or other runtime checks yourself. Canary Lab owns affected-service restart, health checks, and targeted Playwright verification after the signal. If an edit command failed or syntax is uncertain, run at most one fast non-network static check before signalling. Repeat until passed or terminal failure. context.nextSteps also covers fanning out per-failure sub-agents to investigate AND draft patches in parallel (you apply them serially and signal once), rerun-vs-restart, and reusing a run instead of aborting it. A needs_heal task can also be a service that failed to boot — then context.failedTests is empty and context.bootFailure is set because no tests ran. Inspect its reason/classification, command/cwd, exit/signal and bounded redacted excerpt before reading the full logPath. classification:"underlying-cause-not-preserved" means an outer wrapper did not preserve the underlying rejection or child-process failure: do not guess a root cause; fix that product wrapper to log and rethrow, then signal_run kind:"restart" (context.nextSteps already reflects this). context.healPrompt + context.nextSteps ship on the FIRST needs_heal only; later cycles carry context.guidance instead (same loop — call get_heal_context if you need the map back). If the SAME tests fail 3+ cycles running, context.escalation appears: you're stuck — read context.escalation.readFirst and follow context.escalation.tactics (change tactic — revert/build on the prior diff, don't fire a fresh hypothesis) rather than repeating the last fix.

Dependency startup blocks carry context.dependencyBlockers on every needs_heal cycle: repository, affected services, stable cause, requiredAction, worktreePath, and logPath when available. Apply deterministic in-scope repairs without elicitation; ask only for a genuine user choice or missing authority, such as changing another shared checkout. Never offer continue-anyway, mark-compatible, or a revision change as a bypass. Generator-input mismatch does not prove that generated outputs differ. After repair, signal_run kind:"restart" on the same run; both restart and rerun perform a fresh preflight and persist its evidence before any service spawn or test verification. get_heal_context recovers the durable blockers after reconnect.

get_run_snapshot is for verbose debugging only, not for waiting. Read pass counts from result.counts.statusLine / result.counts.passed, never total - failed.

Two awareness signals can ride a run result. Neither changes the verdict, and you never edit the test files to clear either one.

- dirtyTests (a test file changed since the last green run): relay its message to the user VERBATIM (e.g. "⚠️ Tests have been modified, please review.⚠️") — once, alongside the pass/fail outcome. Do NOT block, gate, re-run, or revert on it: the user reviews or commits the change.
- specEdits (test files changed AFTER this run started): the run used the tests recorded at run start, so the changed files were NOT tested — the result you see says nothing about them. Relay specEdits.message and follow specEdits.nextSteps: call get_test_review(runId), show the exact patch (read patchPath if needed), then call review_test_changes(runId, review_revision) WITHOUT wait_for_decision for human elicitation in this agent session. The human chooses Accept & commit or Restore recorded files; cancel/decline leaves pending. Accept & commit binds approval to the displayed revision, commits every reviewed file including helpers/fixtures/config, and returns a durable receipt with Git and execution outcomes. For an active run continue with wait_for_heal_task and do not signal twice; for an ended passed/failed/aborted run call start_run without run_ref when the receipt says new-run-required. Acceptance preserves the old result and never counts as a pass. reviewUrl is optional side-by-side inspection, never a required operational step. If elicitation is unavailable, say that no question was presented; do not claim the human ignored it. Use a capable client, or only if the human chooses browser fallback, wait with the returned browser_wait_token and wait_for_decision:true. A Git commit, clean tree, restart, or chat statement is not a persisted review receipt; only the explicit decision action creates one. Changed revisions require a fresh review. No MCP tool can self-approve a test-file change, and a passed run with pending specEdits is a pass of the RECORDED tests — never report the changed tests as passed. specEdits.hints carries the advisory check: a kind:"weaker" hint means an assertion was removed or loosened relative to the test that ran — restore it, a weaker assertion is never a repair; kind:"cannot-classify" means review by hand. Quote specEdits.disclosure with any hint you quote: one AI labelled the samples; a second AI checked 40 without seeing those labels; no human labelled them.


## Robustness Lab (defects a green run cannot see)

A passing run proves the app under ideal conditions. The Robustness Lab re-runs a
GREEN run's test files under a perturbation envelope — added latency, a duplicated
write, a service restart — injected by a proxy in front of the suite's declared port
slots, so each cell (test file × atom) is a full Canary run of the same tests. A cell
that fails is a finding: the tests that passed green and failed perturbed, their @req
tags, and — after shrinking — the smallest envelope that still reproduces it,
confirmed 3/3. Nothing here edits tests or the envelope; findings feed THIS repair
loop.

1. start_robustness(feature) — optional runId (a PASSED run; default the newest) and
   envelope (default the suite's robustness/envelope.json). 202 returns the job
   record. Refusals name the reason: 409 no passing run or a matrix already running
   (its jobId is in the message — read it instead), 400 no declared port slot (run
   Parallel setup first) or an invalid envelope.
2. get_robustness(jobId) every ~30 s until status leaves "running" — a cell costs a
   run (~10 s plus a service boot), shrink up to 12 search probes per finding. Read
   cells.done/planned, findings[] and skipped[]. A skipped cell was NOT judged (boot
   failure, abort) — never a pass. An unconfirmed finding did not reproduce 3/3 —
   report it as unconfirmed, never as a defect and never as a pass. get_robustness
   (feature) without jobId lists the suite's jobs newest first; the flight's
   links.robustnessJobId names the job its Robustness lab stage ran.
3. For each confirmed finding: start_run(feature, perturbation:
   finding.shrink.envelope ?? finding.envelope, claim_heal:true, session_id,
   conversation_name). The run executes the whole suite under that envelope, so the
   failure reproduces; its needs_heal context carries context.perturbation
   {envelope, repro} and the rule in context.nextSteps. Then the ordinary loop:
   fix, signal_run, wait_for_heal_task — signal_run replays the SAME perturbation,
   so a fix that passes has passed under the fault.

The repair rule is unchanged and sharper here: a perturbation finding is the APP's
intolerance (a missing idempotency key, no timeout, state that does not survive a
restart). Fix the app's tolerance — never loosen the test, never shrink or delete
the envelope, and never widen a timeout in the spec to outlast the latency.

## Discovery repair (test list cannot load)

Use start_discovery_repair with feature, mode: external, and your stable session_id.
Poll get_discovery_repair until promptReady, then read promptPath. Report meaningful
inspection/edit milestones through update_discovery_repair action: progress (at
least once a minute during long work), so Canary shows live progress without a
refresh. Stop editing before action: verify; Canary independently lists tests.
Read the result: succeeded restores the existing Tests list; failed returns the
latest diagnostic. Stop editing and report action: blocked when unable to proceed.
Never weaken tests, run test bodies, or claim success from your own exit message.
Use the shipped canary-lab-repair-discovery skill for the complete workflow.


## User input through MCP 2.0

Let the owning MCP command request missing input with SDK 2.0 elicitation
(`input_required`). The client collects the response and retries the command.
Do not answer a user form yourself or ask the same question in chat first.
Existing user instructions and autopilot choices still apply without another ask.
On `needs-input`, leave work pending after decline/cancel, stale input, or an
unfinished UI action; never retry or repeat the question automatically. Chat is
only the fallback when elicitation is unavailable. Never collect passwords, API
keys, or access tokens in chat or form elicitation: use the returned Canary UI URL.
Setup and reconnection questions still use chat while MCP is unavailable.
