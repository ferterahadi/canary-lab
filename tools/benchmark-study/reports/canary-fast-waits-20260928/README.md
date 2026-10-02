# Faster Canary readiness and repair handoff — 2026-09-28

Implemented and locally verified. Installed server/UI/MCP-client verification remains pending the user-owned `canary-apply` cycle.

## Results

The same local replay protocol ran before and after the change: 10 repetitions per scenario/workflow, 40 attempts per campaign, balanced randomized pairs with seed 42. Both campaigns completed 40/40 independently verified repairs. All model tokens are zero by construction; neither campaign invokes cloud agents. Preparation, regression checks and launcher profiling did not overlap the final replay.

| Workflow | Before, mean | After, mean | Change |
| --- | ---: | ---: | ---: |
| Canary | 8.280s | 6.146s | 25.8% less time |
| Plain | 2.341s | 2.317s | 1.0% less time |

Canary remains slower than the scripted plain workflow. These are sequential local before/after campaigns, not randomized old/new product binaries; CPU/disk/time variation remains possible. This measures fixed known repairs, not live-agent reasoning or token efficiency.

| Canary stage | Before | After |
| --- | ---: | ---: |
| Service spawn to readiness, both boots | 2.030s | 1.507s |
| Both Playwright launches through exit | 3.704s | 3.594s |
| Failed test exit through repair and restart launch | 2.181s | 0.679s |
| Other setup and cleanup | 0.366s | 0.367s |

The accepted-signal-to-restart portion of repair handoff fell from 837ms to 26ms on average. Stage boundaries come from runner log timestamps; they include real work as well as waiting and are not pure polling-cost measurements.

## Implementation

- Readiness probes still run immediately. Subsequent waits start at 100ms and double up to the configured health interval (normally 1s). Explicit shorter intervals and the remaining readiness deadline bound every sleep.
- Signal-file polling defaults to 100ms. Explicit signal intervals take precedence; an explicitly supplied health interval remains the fallback for compatibility.
- `HealSignalGate` wakes the waiting consumer as soon as it accepts a signal. Timers are cleared on wake; timeout wakeups continue checking stop/cancellation, agent liveness, idle and hard limits. Duplicate rejection, the write-before-exit grace period, lifecycle events and evidence paths are retained.
- No changed agent protocol, tool schema, prompt, pass-count derivation or test selection. The agent-facing surfaces were enumerated and inspected; timing is internal and their instructions remain applicable.

## Launcher profiling

A separate local microbenchmark listed the same seven tests through the same reporter without running application requests. Six repetitions per combination, alternating forward/reverse order; the first repetition is excluded below. This measures startup/listing, not the full repair loop or failure-trace enrichment. Outputs and raw timings are retained.

| Launcher | Source reporter | Compiled reporter |
| --- | ---: | ---: |
| Interactive shell + npx | 0.784s | 0.796s |
| Interactive shell + absolute Node/CLI | 0.670s | 0.654s |
| Direct Node/CLI | 0.206s | 0.207s |

The compiled reporter did not materially reduce startup in this check. Direct launch is promising but is not implemented: interactive shell startup intentionally loads user PATH/environment, and `npx` also supplies executable-search context for child commands. Removing either needs compatibility verification for real configurations, beyond this synthetic fixture. The measured improvement above comes only from readiness and signal handling.

## Verification

- Run runtime regressions, shared signal-gate tests and selected MCP wait/guardrail tests: 1,545 passed, one existing skipped test across 107 files, combining the successful broad run with its four temporary-directory failures rerun successfully. The initial sandboxed run also could not bind loopback ports; the authorized local rerun resolved that environment restriction.
- New regressions cover immediate signal delivery/timer cleanup, timeout recovery, 100ms file detection, short health intervals, backoff ceilings and readiness deadlines. Existing cancellation, duplicate, write-before-exit, restart and verdict tests remain passing.
- Build TypeScript, conventions, boundaries, documentation links and whitespace checks passed.
- Live installed UI and connected-agent delivery are unverified. Existing lifecycle/state-sink/event paths remain in use. The repository has no local apply opt-in; its verification skill leaves rebuild/reinstall/restart to the user.

## Evidence

- [New replay report](/private/tmp/canary-replay-fast-waits-20260928-local/report.html)
- [New study and receipts](/private/tmp/canary-replay-fast-waits-20260928-local/study.json)
- [Prior replay report](/private/tmp/canary-comparison-20260928-204119/replay-final/report.html)
- [Machine-readable comparison](comparison.json)
- [Measured runtime patch](runtime.patch)
- [Launcher timing samples](launch-profile.json)
- [Launcher profile logs](/private/tmp/canary-launch-profile-20260928)

The initially attempted new preparation at `/private/tmp/canary-replay-fast-waits-20260928` failed because the sandbox denied local port allocation; it contains no completed campaign and is excluded. The previously prepared 80-attempt live campaign has not run. It remains subject to its earlier explicit payload/destination approval and would need fresh preparation for this changed source fingerprint.
