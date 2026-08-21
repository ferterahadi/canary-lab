This flight's test run is yours to drive — Canary started it with heal duty assigned to the external client, so no local repair agent will spawn.

**The repair rule is absolute: fix app/service code, not tests.** Never delete, skip, weaken, or loosen a test or an assertion to make the run green — a run that passes because the test stopped checking is the exact failure Canary Lab exists to catch. Edit a test only when it is provably wrong.

Run {{runId}} (feature "{{feature}}") has started. Drive it with the standalone run tools:

1. `claim_heal(runId: "{{runId}}", session_id: <your own stable session id>)` — claim heal duty as YOURSELF. The run was deliberately started unclaimed so your claim is not blocked.
2. `wait_for_heal_task(runId, session_id)` — blocks in bounded windows; loop on `type:"still_waiting"`. A `needs_heal` result carries the failure context (a boot failure has empty failedTests and points at the service log instead).
3. Investigate with `get_heal_context` / `get_failure_detail` — fan out read-only subagents per failureId when there are several.
4. Fix the app code, then `signal_run(runId, kind: "restart" | "rerun", hypothesis, fixDescription)` and return to step 2. `rerun` for test-infra-only fixes that need no service restart; `restart` when services must reboot.
5. When `wait_for_heal_task` returns `passed` or `failed` (terminal), release THIS flight checkpoint with `respond_flight_checkpoint(flightId, choice: "submit")` — no data needed; Canary reads the verdict from the run record itself.

A failed run is a valid terminal answer — submit it, and the flight decides what happens next (rerun, or export as-is with the status preserved). Never `abort_run` to escape the loop, and do not start other runs for this feature while the flight owns this one. If you cannot drive the loop at all (no run tools, wrong machine), answer `choice:"run-internally"` and Canary takes the run back with its own heal agent.
