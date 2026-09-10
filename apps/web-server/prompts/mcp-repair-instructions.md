Canary Lab — external repair loop. Fix failing runs by editing app/service code (not tests, unless a test is provably wrong); never delete, skip, weaken, or loosen an assertion to turn a run green.

1. start_run with claim_heal:true, a stable session_id reused for the whole conversation, and conversation_name; do NOT pass client_kind (the bridge detects it). For "rerun <id>" pass run_ref. Special results — type:"repo_collision_requires_choice": ASK THE USER, then re-call with isolation:"worktree" or isolation:"queue", never guess; queued:true: parked, wait_for_heal_task still works; type:"boot_session": services only, no heal task — report readiness, abort_run(confirm:true) stops them; type:"getting_started_busy": follow the active target it returns.
2. wait_for_heal_task with the same runId + session_id. It BLOCKS for a bounded window; type:"still_waiting" is NOT terminal — call it again until needs_heal / passed / failed. Never poll get_run_snapshot or get_run in a loop.
3. On needs_heal follow context.nextSteps (read context.healPrompt.startHere first), apply the fixes YOURSELF, then signal_run ONCE per cycle with hypothesis + fixDescription, and wait_for_heal_task again. The signal requests runner verification; it is not a claim that the fix already passes. Do not start services or run Playwright or other runtime checks yourself. Canary Lab owns affected-service restart, health checks, and targeted Playwright verification after the signal.

Read pass counts from result.counts.statusLine / result.counts.passed, never total - failed (a not-run test is not a pass). dirtyTests and specEdits are awareness signals: relay each message VERBATIM once; never edit the test files to clear them. specEdits = specs changed after the run started and were NOT tested: restore them, or ask the human to adopt in Canary Lab (no tool can adopt); a weaker hint → restore.

Full guide (boot failures, escalation, fan-out, rerun vs restart, Robustness Lab): get_workflow_guide(workflow:"repair").

<!-- initialize-cut -->
Details:

1. start_run with claim_heal:true, a stable session_id reused for the whole conversation, and conversation_name. Do NOT pass client_kind — the MCP bridge auto-detects it from the connection; passing it yourself can mis-set it and suppress heal claim. Heal claiming is open to interactive Claude/Codex clients (Desktop or CLI); it is suppressed only for runner-spawned PTY agents Canary Lab launches itself. For "rerun <id>" pass run_ref (e.g. "7cvh").
   - If start_run returns type:"repo_collision_requires_choice", another run is using the same app/repo. ASK THE USER whether to run isolated (a per-run git worktree, concurrent) or queue until the other run finishes, then re-call start_run with isolation:"worktree" or isolation:"queue". Do not guess.
   - If start_run returns type:"getting_started_busy", a Getting Started demo already owns the workspace. Follow the active target it returns; do not start another run or Flight.
   - If start_run returns queued:true, the run is parked (queueReason tells you why) and will start automatically when capacity frees; wait_for_heal_task still works — it blocks until the run starts and needs fixes.
   - If start_run (or wait_for_heal_task) returns type:"boot_session" (executionType:"boot"), the run is a held boot-only session: services are up, no tests run, and there is NO heal task. Do not wait for heal — report that services are ready and that abort_run (confirm:true) stops them. A service that fails its readiness probe is marked failed (its status shows "timeout") but the session stays held — boot never self-aborts on a health-check failure, so report which services came up and which failed; only abort_run tears it down.
2. wait_for_heal_task with the same runId + session_id. This BLOCKS for a short bounded window (and heartbeats for you) until the run needs fixes, passes, or fails. If it returns type:"still_waiting" the run is still active and the window simply elapsed — this is NOT terminal: immediately call wait_for_heal_task again with the same runId + session_id. Loop on still_waiting until you get needs_heal / passed / failed. Always wait this way — never poll get_run_snapshot or get_run in a loop.
3. On needs_heal the result is self-describing: follow context.nextSteps (read context.healPrompt.startHere first), apply all the fixes YOURSELF, then signal_run ONCE per cycle with hypothesis + fixDescription, and wait_for_heal_task again. The signal requests runner verification; it is not a claim that the fix already passes. Do not start services or run Playwright, smoke, end-to-end, or other runtime checks yourself. Canary Lab owns affected-service restart, health checks, and targeted Playwright verification after the signal. If an edit command failed or syntax is uncertain, run at most one fast non-network static check before signalling. Repeat until passed or terminal failure. context.nextSteps also covers fanning out per-failure sub-agents to investigate AND draft patches in parallel (you apply them serially and signal once), rerun-vs-restart, and reusing a run instead of aborting it. A needs_heal task can also be a service that failed to boot — then context.failedTests is empty and context.bootFailure is set (service name + log path) because no tests ran; Read bootFailure.logPath to find why the service won't serve, fix the service/app code, then signal_run kind:"restart" (context.nextSteps already reflects this). context.healPrompt + context.nextSteps ship on the FIRST needs_heal only; later cycles carry context.guidance instead (same loop — call get_heal_context if you need the map back). If the SAME tests fail 3+ cycles running, context.escalation appears: you're stuck — read context.escalation.readFirst and follow context.escalation.tactics (change tactic — revert/build on the prior diff, don't fire a fresh hypothesis) rather than repeating the last fix.

get_run_snapshot is for verbose debugging only, not for waiting. Read pass counts from result.counts.statusLine / result.counts.passed, never total - failed.

Two awareness signals can ride a run result. Neither changes the verdict, and you never edit the test files to clear either one.

- dirtyTests (a test spec changed since the last green run): relay its message to the user VERBATIM (e.g. "⚠️ Tests have been modified, please review.⚠️") — once, alongside the pass/fail outcome. Do NOT block, gate, re-run, or revert on it: the user reviews or commits the change.
- specEdits (a spec changed AFTER this run started): the run executed a copy of the suite taken at run start, so the edited spec was NOT tested — the result you see says nothing about it. Relay specEdits.message and follow specEdits.nextSteps: restore the spec to what the run started with, or ask the human to adopt the edits in Canary Lab (adopting re-runs the suite against them). No MCP tool can adopt or approve a spec edit, and a passed run with pending specEdits is a pass of the ORIGINAL suite — never report the edited tests as passed. specEdits.hints lists what the strength differential read: a kind:"weaker" hint means an assertion was removed or loosened relative to what ran — restore it, a weaker assertion is never a repair; kind:"cannot-classify" means review by hand. Hints are advisory and carry specEdits.disclosure (one AI labelled, a second AI checked blind, no human) — quote it if you quote a hint.


## Robustness Lab (defects a green run cannot see)

A passing run proves the app under ideal conditions. The Robustness Lab re-runs a
GREEN run's spec files under a perturbation envelope — added latency, a duplicated
write, a service restart — injected by a proxy in front of the suite's declared port
slots, so each cell (spec file × atom) is a full Canary run of the same tests. A cell
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
