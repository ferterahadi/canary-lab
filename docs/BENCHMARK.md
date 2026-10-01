# Benchmark: Repairs With and Without Canary Lab

**On the bundled storefront demo, median repair time was 71 seconds with Canary Lab and 132 seconds without it. Median output-token use was 63% lower.** Each workflow passed all 20 reported attempts; Canary Lab was faster in all 20 pairs, including one [selected rerun](#requested-rerun).

The study ran on 2026-10-01 with Canary Lab 2.3.2, using Claude Code and Codex on two scenarios with seeded bugs. These results apply to this demo and configuration; see [Limits](#limits) for scope and uncertainty.

## Results

Each group contains five paired attempts on the same scenario. *Time* includes setup, agent work, services and tests through the independent evaluator's verdict.

Paired values list Canary Lab first, then the workflow without it. Total tokens include input, output and cached traffic; dollar cost was not measured.

| Agent and bug | Median time: Canary → plain | Time saved (95% range) | Median output tokens | Median test runs |
| --- | --- | --- | --- | --- |
| Claude, one-service bug | 34s → 113s | 71% (70 to 74%) | 1.6k → 7.1k | 2 → 9 |
| Codex, one-service bug | 67s → 156s | 67% (40 to 80%) | 1.8k → 3.7k | 2 → 4 |
| Codex, three-service bug | 106s → 188s | 47% (28 to 62%) | 3.3k → 5.7k | 3 → 4 |
| Claude, three-service bug | 75s → 127s | 42%; interval not reported | 4.1k → 8.5k | 2 → 7 |
| **All 20 selected pairs** | **71s → 132s** | | **2.4k → 6.7k** | **2 → 4.5** |

- **Both workflows passed every executed attempt:** 40 original attempts plus two rerun attempts. The evaluator found no difference in pass rate in this sample. The observed gains were lower elapsed time and token use.
- **Totals across the 40 selected attempts:** 1,390 seconds with Canary Lab against 3,228 without (−57%), and 7.7 million tokens processed against 13.3 million (−43%).

## Requested Rerun

Claude three-service repeat 1 was rerun once under identical pins: **137.7s → 97.1s originally; 68.4s → 149.3s on the rerun**. Both pairs passed; the table uses the fresh pair and preserves the original evidence. Because this pair was selected after observing its result, the updated group is descriptive and has no new confidence interval; the original interval crossed zero.

## Where the Time and Token Savings Came From

The largest difference in the activity breakdown is service and test management. Without Canary Lab, the agent starts services, runs tests, reads their output, and manages subsequent runs. With Canary Lab, the harness starts services and runs tests, then provides failure evidence to the agent. In both workflows, the agent reads and edits application code.

The table shows averages from the original 40 attempts, before the rerun. Tokens here are output tokens:

| Activity | Claude: plain | Claude: Canary | Codex: plain | Codex: Canary |
| --- | --- | --- | --- | --- |
| **Starting, stopping and checking services** | 4.1 steps · 30s · 2.1k tokens | 1.3 · 8s · 0.5k | 7.2 · 78s · 1.7k | 1.4 · 11s · 0.4k |
| **Agent: running tests and reading results** | 4.6 · 37s · 2.2k | 0 · 0s · 0k | 5.9 · 54s · 1.3k | 0.4 · 3s · 0.1k |
| Reading the failure evidence Canary handed over | — | 1.0 · 5s · 0.1k | — | 2.1 · 15s · 0.4k |
| Getting oriented: instructions, requirements, test files | 2.9 · 18s · 1.0k | 2.6 · 14s · 0.9k | 1.5 · 11s · 0.3k | 2.7 · 16s · 0.5k |
| Reading and editing application code | 1.6 · 16s · 1.4k | 2.6 · 19s · 1.6k | 3.1 · 40s · 1.2k | 2.4 · 22s · 0.8k |
| Asking Canary for a rerun | — | 1.0 · 6s · 0.4k | — | 1.4 · 9s · 0.3k |
| Writing the final report | 12s · 0.9k | — | 15s · 0.5k | 1s · 0.1k |
| **Canary: executing tests** | — | 2.0 runs · 3.6s · 0 tokens | — | 2.3 runs · 4.2s · 0 tokens |
| Canary: service boot and restarts | — | 2.1s | — | 2.4s |
| **Average attempt** | **117s · 7.6k** | **61s · 3.5k** | **201s · 4.9k** | **85s · 2.6k** |

Agent rows count tool calls; time includes the model response and tool execution. Mixed calls are counted under their main activity. Canary rows measure execution directly from lifecycle timestamps, with no model tokens; agent evidence reading is separate. This breakdown does not isolate causal effects.

The fresh Claude rerun also measured **2 test runs in 3.838s** (2.815s initial + 1.022s verification), plus 1.491s for service boot/restart. Zero in the agent row means no manual test-running calls, not missing measurements.

What the breakdown shows:

- **Service and test management accounts for about 95% of the time difference in this breakdown.**
  - **Claude:** 67s without Canary against 8s plus Canary's own 6s, which covers 53s of the 56s gap.
  - **Codex:** 132s against 14s plus 7s, which covers 111s of the 116s gap.
- **The same activities account for most of the output-token difference.** Each extra service or test step adds another model response.
- **More steps also mean more context processed.** Each step includes conversation context, much of it served from the prompt cache. Without Canary Lab, attempts averaged 13–18 steps; with it, they averaged 8–10.
- **Canary Lab adds evidence review and rerun requests.**
  - The agent reads the failure evidence and asks for a rerun, which takes 11–24 seconds per attempt.
  - The harness boots services and runs tests, which takes about 6–7 seconds.
- **The relative gain was smaller on the three-service bug.** More time went into reading and editing code, leaving service and test management as a smaller share of the attempt.

## What Affects the Numbers

- **Model request time was the largest component for Claude in the original campaign.** Requests were 83–86% of Claude's wall time in both workflows, according to its request telemetry. Codex's telemetry does not record comparable request timing. Slower requests would be expected to affect the plain workflow more because it takes more steps; the study did not vary network or provider conditions separately.
- **Machine speed** changes how long services take to boot and Playwright takes to run, in both workflows.
- **Harness overhead** was about 4 seconds in a scripted replay with no model: 6.5 seconds with Canary Lab against 2.4 without. For a repair requiring very few agent steps, that overhead could offset the time saved.
- **Repair complexity** changes the share of time spent managing services and tests. The original campaign showed smaller savings on the three-service bug.
- **Token counts measure usage.** Total tokens include context the model reread, mostly from the prompt cache; output tokens count what it generated. The study reports both and does not measure dollar cost.
- **Models, effort and command-line client versions** were pinned. Other versions can behave differently.

## The Demo Used in the Study

The study used the storefront bundled with new workspaces, `templates/project/demo-app`.

- **The app:** a catalog service, an inventory service and a checkout service, which together make up one customer purchase flow.
- **The tests:** the `templates/project/features/storefront-journey` suite has seven Playwright journeys.
- **The defects:** `tools/storefront-repairs.mjs` defines ten seeded defects. Each scenario fixes all of them except the ones it leaves in place (`tools/benchmark-study/scenarios.ts`):
  - **One-service bug:** the checkout discount is never applied. Three journeys fail.
  - **Three-service bug:** one defect in each service — catalog product codes, inventory stock arithmetic and the checkout discount. Four journeys fail.

## The Two Workflows

Both workflows used the same agent, model, reasoning effort, bug and repair rules. Each was told to fix application code, never to weaken or skip tests, and a separate evaluator decided the result.

- **With Canary Lab:** the standard repair loop. Canary Lab started the services, ran the suite, provided failure evidence to the agent, and reran the tests when the agent asked. Diagnosis used the 2.3.2 default, in which the main agent diagnoses failures without delegating to sub-agents.
- **Without Canary Lab:** the agent received `tools/benchmark-study/plain-prompt.md` and a generated runbook listing service commands, ports, logs and the test command. It started the services, ran Playwright and managed restarts itself.
- **Neither workflow had a browser tool,** and both ran in each command-line client's native sandbox.

## How We Measure

- **Time:** the controller's recorded `timing.independentVerdictMs`, from dispatch to the independent evaluator's verdict.
- **Tokens:** read from each client's own session logs. *Output tokens* are what the model generated. *Total tokens* also include context the model reread, mostly from the prompt cache.
- **Test runs:** counted by a hook that records every Playwright start.
- **Correctness:** a separate evaluator reruns the suite on the final code and determines pass or fail from that run.
- **Design:**
  - Attempts run in pairs, one per workflow, in a shuffled order fixed by a seed.
  - Each workflow goes first equally often.
  - Each agent repeats each bug five times, with the one replacement noted above.
  - Reported 95% ranges come from 5,000 paired resamples.
- **Pinned for this run:**

| Item | Value |
| --- | --- |
| Date | 2026-10-01 |
| Canary Lab source | Original: `25b4b9a5` plus the receipt-label fix committed as `bdaea8cd`; rerun: `bdaea8cd`, identical source fingerprint |
| Claude | `claude-opus-5-5`, high effort, Claude Code 2.1.284 |
| Codex | `gpt-6-sol`, high effort, codex-cli 0.158.0 |
| Machine | One macOS machine, attempts run one at a time |
| Seed | 20261001 |

## Limits

- **Bundled demo.** The storefront is Canary Lab's own demo, and its bugs are seeded. Results on an unfamiliar repository can differ.
- **Small sample.** Five pairs per group; the selected rerun is explained above.
- **Extra fixes are not scored.** In all five one-service attempts without Canary Lab, Claude also changed how the catalog assigns product IDs. The evaluator does not reward or penalise that.
- **Unmeasured:** dollar cost, the value of Flight onboarding or coverage work, and repairs that need a browser tool.

## Reproduce It

Follow `tools/benchmark-study/README.md`: create a demo workspace with `npm run demo`, then use the pinned values above.

```bash
npm run benchmark:study -- prepare --workspace <demo-project> --out <new-study> \
  --codex-model gpt-6-sol --codex-effort high --claude-model claude-opus-5-5 --claude-effort high \
  --mode live --repetitions 5 --seed 20261001
npm run benchmark:study -- run --study <new-study>
npm run benchmark:study -- report --study <new-study>
```

The campaign's full evidence stays in the workspace that ran it (`<workspace>/benchmark-evidence/with-without-20261001/`). That includes every transcript, test log, cycle prompt and the generated report. Original evidence is under `live-r5/`; the requested pair and latest-result analysis are under `claude-cross-service-rerun-20261001/`.

## Related

- [Unfamiliar-repository diagnosis study](../tools/benchmark-study/docs/unfamiliar-repository-policy-result-2026-10-01.md) — why 2.3.2 makes the main agent diagnose failures by default.

## Appendix: Every Pair

| Agent | Bug | Repeat | Time: Canary → plain | Output tokens | Total tokens | Test runs |
| --- | --- | --- | --- | --- | --- | --- |
| Claude | three-service | 1 (rerun) | 68s → 149s | 3.6k → 8.3k | 372k → 671k | 2 → 7 |
| Claude | three-service | 2 | 75s → 105s | 4.1k → 8.5k | 453k → 634k | 2 → 7 |
| Claude | three-service | 3 | 53s → 140s | 3.6k → 9.0k | 435k → 631k | 2 → 7 |
| Claude | three-service | 4 | 101s → 123s | 6.1k → 8.9k | 546k → 792k | 2 → 6 |
| Claude | three-service | 5 | 77s → 127s | 4.7k → 7.9k | 327k → 657k | 2 → 5 |
| Claude | one-service | 1 | 35s → 113s | 2.0k → 7.1k | 297k → 620k | 2 → 7 |
| Claude | one-service | 2 | 30s → 119s | 1.4k → 6.7k | 304k → 427k | 2 → 8 |
| Claude | one-service | 3 | 34s → 113s | 1.6k → 6.6k | 305k → 619k | 2 → 10 |
| Claude | one-service | 4 | 31s → 111s | 1.3k → 7.8k | 245k → 658k | 2 → 10 |
| Claude | one-service | 5 | 36s → 122s | 1.9k → 7.3k | 246k → 533k | 2 → 9 |
| Codex | three-service | 1 | 80s → 273s | 2.8k → 5.7k | 338k → 764k | 2 → 4 |
| Codex | three-service | 2 | 110s → 166s | 3.1k → 6.2k | 389k → 655k | 2 → 4 |
| Codex | three-service | 3 | 96s → 188s | 3.3k → 4.7k | 588k → 798k | 3 → 3 |
| Codex | three-service | 4 | 115s → 136s | 3.6k → 4.1k | 699k → 687k | 3 → 4 |
| Codex | three-service | 5 | 106s → 202s | 3.5k → 7.8k | 697k → 792k | 3 → 4 |
| Codex | one-service | 1 | 86s → 100s | 1.8k → 3.0k | 280k → 731k | 2 → 4 |
| Codex | one-service | 2 | 55s → 353s | 1.7k → 3.7k | 295k → 584k | 2 → 4 |
| Codex | one-service | 3 | 60s → 129s | 1.7k → 3.7k | 235k → 716k | 2 → 4 |
| Codex | one-service | 4 | 67s → 302s | 1.9k → 5.4k | 327k → 774k | 2 → 4 |
| Codex | one-service | 5 | 74s → 156s | 2.1k → 4.9k | 281k → 599k | 2 → 4 |
