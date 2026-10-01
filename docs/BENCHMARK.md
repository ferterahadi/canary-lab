# Benchmark: Repairs With and Without Canary Lab

**On the bundled storefront demo, Claude Code and Codex fixed the same bugs in a median 74 seconds instead of 128, with 64% fewer output tokens, when Canary Lab ran the repair loop.** Both workflows fixed all 20 of their attempts. Canary Lab was faster in 19 of the 20 pairs.

The study ran on 2026-10-01 with Canary Lab 2.3.2. It is a controlled sample on Canary Lab's own demo, not proof that Canary Lab is faster on every app. Read [Limits](#limits) before quoting it.

## Results

Each group is five paired attempts on the same bug. *Time* runs from starting the agent to a separate evaluator's verdict, so it includes starting services and every test run.

| Agent and bug | Median time: Canary → plain | Time saved (95% range) | Median output tokens | Median test runs |
| --- | --- | --- | --- | --- |
| Claude, one-service bug | 34s → 113s | 72% (70 to 74%) | 1.6k → 7.1k | 2 → 9 |
| Codex, one-service bug | 67s → 156s | 67% (41 to 80%) | 1.8k → 3.7k | 2 → 4 |
| Codex, three-service bug | 106s → 188s | 48% (28 to 62%) | 3.3k → 5.7k | 3 → 4 |
| Claude, three-service bug | 77s → 123s | 25% (−8 to 49%) | 4.7k → 8.5k | 2 → 6 |
| **All 20 pairs** | **74s → 128s** | | **2.4k → 6.6k** | **2 → 4** |

- **Correctness was equal.** Every attempt in both workflows passed the independent check. Canary Lab's gain is speed and cost, not fixing bugs an agent otherwise could not.
- **Totals across all 40 attempts:** 1,441 seconds with Canary Lab against 3,158 without (−54%), and 8.1 million tokens processed against 13.2 million (−38%).
- **The Claude three-service result could be a tie.** Its 95% range crosses zero.

## Why Canary Lab Is Faster and Cheaper

Almost all of the saving comes from one place. Without Canary Lab, the agent starts the services, runs the tests and reads their output itself, and it repeats that after every change. With Canary Lab, the harness does that work and hands the agent the failure evidence. The thinking work, reading and fixing application code, costs about the same in both workflows.

The table shows the average attempt, split by what the agent was doing at each step:

| What the agent was doing | Claude: plain | Claude: Canary | Codex: plain | Codex: Canary |
| --- | --- | --- | --- | --- |
| **Starting, stopping and checking services** | 4.1 steps · 30s · 2.1k tokens | 1.3 · 8s · 0.5k | 7.2 · 78s · 1.7k | 1.4 · 11s · 0.4k |
| **Running tests and reading results** | 4.6 · 37s · 2.2k | none: Canary runs them | 5.9 · 54s · 1.3k | 0.4 · 3s · 0.1k |
| Reading the failure evidence Canary handed over | — | 1.0 · 5s · 0.1k | — | 2.1 · 15s · 0.4k |
| Getting oriented: instructions, requirements, test files | 2.9 · 18s · 1.0k | 2.6 · 14s · 0.9k | 1.5 · 11s · 0.3k | 2.7 · 16s · 0.5k |
| Reading and editing application code | 1.6 · 16s · 1.4k | 2.6 · 19s · 1.6k | 3.1 · 40s · 1.2k | 2.4 · 22s · 0.8k |
| Asking Canary for a rerun | — | 1.0 · 6s · 0.4k | — | 1.4 · 9s · 0.3k |
| Writing the final report | 12s · 0.9k | — | 15s · 0.5k | 1s · 0.1k |
| Canary's own service boot and test runs | — | about 6s | — | about 7s |
| **Average attempt** | **117s · 7.6k** | **61s · 3.5k** | **201s · 4.9k** | **85s · 2.6k** |

A *step* is one tool call, and the time is the model's response plus the tool's execution. Steps are classified from their commands, so a step that mixes activities is counted once under its main activity.

What the breakdown shows:

- **Managing services and tests explains about 95% of the time saved.**
  - **Claude:** 67s without Canary against 8s plus Canary's own 6s, which covers 53s of the 56s gap.
  - **Codex:** 132s against 14s plus 7s, which covers 111s of the 116s gap.
- **The same work explains most of the output-token saving.** Each extra service or test step is another model response.
- **Total tokens follow the number of steps.** Every step resends the whole conversation, mostly from the prompt cache. Without Canary Lab, attempts averaged 13–18 steps; with it, they averaged 8–10.
- **Canary Lab adds a little work of its own.**
  - The agent reads the handed-over evidence and asks for a rerun, which costs 11–24 seconds per attempt.
  - The harness boots services and runs tests, which takes about 6–7 seconds.
- **The gain shrinks when the fix itself dominates.** The three-service bug needs more reading and editing, so the fixed service-and-test saving is a smaller share of the attempt.

## What Affects the Numbers

- **Network and model provider speed dominate.** Model requests were 83–86% of Claude's wall time in both workflows; this comes from Claude's request telemetry. Codex's telemetry does not record comparable request timing. A slower connection or a busier provider makes every step slower, which affects the plain workflow more because it takes more steps.
- **Machine speed** changes how long services take to boot and Playwright takes to run, in both workflows.
- **Canary Lab's fixed overhead** is about 4 seconds per attempt. A scripted replay with no model measured 6.5 seconds with Canary Lab against 2.4 without. On a bug an agent fixes in one step, that overhead can cancel the gain.
- **Bug difficulty** sets how much of an attempt is service and test management. The one-service bug saved 67–72% of the time; the three-service bug saved 25–48%.
- **Prompt-cache hits** change total tokens much more than output tokens. Output tokens are the more stable cost signal.
- **Models, effort and command-line client versions** were pinned. Other versions can behave differently.

## The Demo We Measure On

The study uses the storefront that every new workspace ships with, `templates/project/demo-app`.

- **The app:** a catalog service, an inventory service and a checkout service, which together make up one customer purchase flow.
- **The tests:** the `templates/project/features/storefront-journey` suite has seven Playwright journeys.
- **The defects:** `tools/storefront-repairs.mjs` defines ten seeded defects. Each scenario fixes all of them except the ones it leaves in place (`tools/benchmark-study/scenarios.ts`):
  - **One-service bug:** the checkout discount is never applied. Three journeys fail.
  - **Three-service bug:** one defect in each service — catalog product codes, inventory stock arithmetic and the checkout discount. Four journeys fail.

## The Two Workflows

Both workflows used the same agent, model, reasoning effort, bug and repair rules. Each was told to fix application code, never to weaken or skip tests, and a separate evaluator decided the result.

- **With Canary Lab:** the real repair loop. Canary Lab started the services, ran the suite, handed the failures to the agent, and reran the tests when the agent asked. Diagnosis used the 2.3.2 default, in which the main agent diagnoses failures without delegating to sub-agents.
- **Without Canary Lab:** the agent received `tools/benchmark-study/plain-prompt.md` and a generated runbook listing service commands, ports, logs and the test command. It started the services, ran Playwright and managed restarts itself.
- **Neither workflow had a browser tool,** and both ran in each command-line client's native sandbox.

## How We Measure

- **Time:** from starting the agent to the independent evaluator's verdict.
- **Tokens:** read from each client's own session logs. *Output tokens* are what the model generated. *Total tokens* also include context the model reread, mostly from the prompt cache.
- **Test runs:** counted by a hook that records every Playwright start.
- **Correctness:** a separate evaluator reruns the suite on the final code. The agent's own report does not count.
- **Design:**
  - Attempts run in pairs, one per workflow, in a shuffled order fixed by a seed.
  - Each workflow goes first equally often.
  - Each agent repeats each bug five times.
  - The 95% ranges come from 5,000 paired resamples.
- **Pinned for this run:**

| Item | Value |
| --- | --- |
| Date | 2026-10-01 |
| Canary Lab source | `25b4b9a5`, plus a receipt-label fix later committed as `bdaea8cd` |
| Claude | `claude-opus-5-5`, high effort, Claude Code 2.1.284 |
| Codex | `gpt-6-sol`, high effort, codex-cli 0.158.0 |
| Machine | One macOS machine, attempts run one at a time |
| Seed | 20261001 |

## Limits

- **Home ground.** The storefront is Canary Lab's own demo, and its bugs are seeded. Results on an unfamiliar repository can differ.
- **Small sample.** Each group has five pairs. The Claude three-service group cannot rule out a tie.
- **One loss.** In Claude three-service attempt 1, Canary Lab took 137 seconds against 97.
- **Extra fixes are not scored.** In all five one-service attempts without Canary Lab, Claude also changed how the catalog assigns product IDs. The evaluator does not reward or penalise that.
- **Not measured:** dollar cost, the value of Flight onboarding or coverage work, and repairs that need a browser tool.

## Reproduce It

Follow `tools/benchmark-study/README.md`: create a demo workspace with `npm run demo`, then use the pinned values above.

```bash
npm run benchmark:study -- prepare --workspace <demo-project> --out <new-study> \
  --codex-model gpt-6-sol --codex-effort high --claude-model claude-opus-5-5 --claude-effort high \
  --mode live --repetitions 5 --seed 20261001
npm run benchmark:study -- run --study <new-study>
npm run benchmark:study -- report --study <new-study>
```

The campaign's full evidence stays in the workspace that ran it (`<workspace>/benchmark-evidence/with-without-20261001/`). That includes every transcript, test log, cycle prompt and the generated report.

## Related

- [Unfamiliar-repository diagnosis study](../tools/benchmark-study/docs/unfamiliar-repository-policy-result-2026-10-01.md) — why 2.3.2 makes the main agent diagnose failures by default.

## Appendix: Every Pair

| Agent | Bug | Repeat | Time: Canary → plain | Output tokens | Total tokens | Test runs |
| --- | --- | --- | --- | --- | --- | --- |
| Claude | three-service | 1 | 137s → 97s | 8.2k → 6.5k | 850k → 495k | 2 → 4 |
| Claude | three-service | 2 | 75s → 104s | 4.1k → 8.5k | 449k → 626k | 2 → 7 |
| Claude | three-service | 3 | 53s → 139s | 3.6k → 9.0k | 432k → 623k | 2 → 7 |
| Claude | three-service | 4 | 100s → 123s | 6.1k → 8.9k | 540k → 783k | 2 → 6 |
| Claude | three-service | 5 | 77s → 127s | 4.7k → 7.9k | 322k → 649k | 2 → 5 |
| Claude | one-service | 1 | 34s → 112s | 2.0k → 7.1k | 295k → 613k | 2 → 7 |
| Claude | one-service | 2 | 29s → 119s | 1.4k → 6.7k | 303k → 420k | 2 → 8 |
| Claude | one-service | 3 | 34s → 113s | 1.6k → 6.6k | 304k → 613k | 2 → 10 |
| Claude | one-service | 4 | 30s → 111s | 1.3k → 7.8k | 244k → 650k | 2 → 10 |
| Claude | one-service | 5 | 36s → 121s | 1.9k → 7.3k | 244k → 526k | 2 → 9 |
| Codex | three-service | 1 | 80s → 272s | 2.8k → 5.7k | 336k → 758k | 2 → 4 |
| Codex | three-service | 2 | 110s → 166s | 3.1k → 6.2k | 385k → 649k | 2 → 4 |
| Codex | three-service | 3 | 95s → 188s | 3.3k → 4.7k | 585k → 793k | 3 → 3 |
| Codex | three-service | 4 | 114s → 135s | 3.6k → 4.1k | 696k → 683k | 3 → 4 |
| Codex | three-service | 5 | 106s → 201s | 3.5k → 7.8k | 693k → 784k | 3 → 4 |
| Codex | one-service | 1 | 86s → 100s | 1.8k → 3.0k | 279k → 728k | 2 → 4 |
| Codex | one-service | 2 | 55s → 353s | 1.7k → 3.7k | 294k → 580k | 2 → 4 |
| Codex | one-service | 3 | 59s → 128s | 1.7k → 3.7k | 234k → 713k | 2 → 4 |
| Codex | one-service | 4 | 67s → 301s | 1.9k → 5.4k | 325k → 769k | 2 → 4 |
| Codex | one-service | 5 | 73s → 155s | 2.1k → 4.9k | 279k → 595k | 2 → 4 |
