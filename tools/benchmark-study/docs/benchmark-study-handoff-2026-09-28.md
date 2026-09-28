# Canary Lab repair benchmark — evidence handoff

**As of 2026-09-28.** This document is a reading guide for a separate analysis. It records the measured outcomes and where to inspect the original evidence. It does not claim that Canary Lab is generally superior or identify a causal mechanism for the differences.

## Read this first

The latest four-way comparison is the **16-attempt live full-loop study**. Codex (`gpt-6-sol`) and Claude (`claude-opus-5-5`) each repaired two broken storefront scenarios twice with Canary Lab and twice using ordinary shell commands and Playwright. All 16 attempts passed independent verification. Mean **repair** time and reported token traffic per attempt were:

| Agent and workflow | Verified | Mean repair time | Mean tokens, including cache | Observed Playwright launches |
| --- | ---: | ---: | ---: | ---: |
| Plain Codex | 4/4 | 155.5 s | 701,784 | 12 |
| Canary + Codex | 4/4 | 118.1 s | 1,031,332 | 9 |
| Plain Claude | 4/4 | 174.6 s | 681,569 | 41 |
| Canary + Claude | 4/4 | 84.5 s | 627,125 | 8 |

Within each agent, Canary + Codex was **24.1% faster and used 47.0% more tokens** than plain Codex; Canary + Claude was **51.6% faster and used 8.0% fewer tokens** than plain Claude. These are descriptive means over four attempts per combination, not a cross-provider cost comparison. The [primary report](../tools/benchmark-study/reports/canary-full-loop-live-16-20260928/README.md), [machine-readable summary](../tools/benchmark-study/reports/canary-full-loop-live-16-20260928/summary.json), and [full attempt report](/private/tmp/canary-full-loop-live-16-20260928/report.md) are the source of these values.

The user then requested a **fresh Codex-only repeat**. All eight new repairs passed. Plain Codex averaged **161.6 s and 662,608 tokens**; Canary + Codex averaged **122.0 s and 976,435 tokens**. Canary was **24.5% faster and used 47.4% more tokens** in that round. It was faster in three of four matched pairs. The [repeat report](../tools/benchmark-study/reports/codex-repeat-20260928/README.md) and its [summary](../tools/benchmark-study/reports/codex-repeat-20260928/summary.json) preserve this separately from the first round. **Claude was not repeated.**

## Protocol and measurement boundary

- **Task:** A prepared three-service storefront, copied from the `npm run demo` application. `single-service` and `cross-service` are frozen broken snapshots. Agents diagnosed failures, edited application code, ran tests, and retried. The plain workflow had a runbook, shell commands, raw logs, and Playwright; it was not a bare model prompt. The [study protocol](../tools/benchmark-study/README.md) describes both workflows and the fairness controls.
- **Settings:** Codex `gpt-6-sol` and Claude `claude-opus-5-5`, both at high effort; Codex CLI 0.158.0 and Claude Code 2.1.283. Each attempt had a 15-minute limit. Canary/plain pairs were adjacent with balanced seeded ordering (`42`). The original source revision was `4fb1cc21cf26c9afc53a54faee6003323bcae652`; the source digest also captured the then-dirty tree. The Codex repeat checked the same source, dependency, and broken-snapshot fingerprints, though it ran as two separate scenario campaigns.
- **Success:** An independent evaluator ran the seven original Playwright journeys and additional input checks on fresh application state. Protected test/helper/configuration edits invalidate an attempt. The 16 original and eight repeated repairs all passed. The primary study's independent verification took **14.822 s total**; the Codex repeat took **8.951 s total**. Those verifier times are **excluded** from repair time.
- **Time:** Repair time includes worker setup, service startup, diagnosis, application edits, tests, retries, session/artifact capture, and cleanup. Campaign preparation and CLI preflight are separate. The original report records **54.0 s preparation** and **44.5 s native preflight**. It does not measure initial product onboarding or the cumulative time spent designing/debugging the experiment.
- **Tokens:** Native session counters include input, output, and cached traffic, including available delegated diagnosis and Codex approval-review sessions. Codex cached input is already inside its input count; Claude cache reads and writes are added to its input/output fields. These counts are **not dollar cost** and are not an equal-compute comparison across providers. The Codex repeat [audited original totals](../tools/benchmark-study/reports/codex-repeat-20260928/original-token-audit.json) and [audited repeat totals](../tools/benchmark-study/reports/codex-repeat-20260928/repeat-token-audit.json) against copied native logs; all audited totals matched, with no duplicate session IDs across rounds.
- **Uncertainty:** This is one synthetic storefront, two issue types, and two repeats per combination. There is no reliable confidence interval, independent-repository validation, causal ablation, or measured dollar cost. Live elapsed time includes provider, model, and network variation. Request telemetry is partial and overlapping; subtracting its duration sums would not isolate local time. The workflows also differ in delegation behavior. Treat the four-way ranking as descriptive, and compare Canary/plain within the same agent.

## Where to inspect the evidence

| Evidence | Original full-loop study | Fresh Codex repeat |
| --- | --- | --- |
| Durable readout and aggregate JSON | [README](../tools/benchmark-study/reports/canary-full-loop-live-16-20260928/README.md) · [summary.json](../tools/benchmark-study/reports/canary-full-loop-live-16-20260928/summary.json) · [report.json copy](../tools/benchmark-study/reports/canary-full-loop-live-16-20260928/report.json) | [README](../tools/benchmark-study/reports/codex-repeat-20260928/README.md) · [summary.json](../tools/benchmark-study/reports/codex-repeat-20260928/summary.json) · [token audits](../tools/benchmark-study/reports/codex-repeat-20260928/original-token-audit.json) |
| Full report and frozen manifest | [report.md](/private/tmp/canary-full-loop-live-16-20260928/report.md) · [report.html](/private/tmp/canary-full-loop-live-16-20260928/report.html) · [study.json](/private/tmp/canary-full-loop-live-16-20260928/study.json) | [single-service report](/private/tmp/canary-codex-repeat-single-20260928/report.md) · [single-service manifest](/private/tmp/canary-codex-repeat-single-20260928/study.json) · [cross-service report](/private/tmp/canary-codex-repeat-cross-20260928/report.md) · [cross-service manifest](/private/tmp/canary-codex-repeat-cross-20260928/study.json) |
| Raw attempt root | `/private/tmp/canary-full-loop-live-16-20260928/attempts/` | `/private/tmp/canary-codex-repeat-single-20260928/attempts/` and `/private/tmp/canary-codex-repeat-cross-20260928/attempts/` |
| Results and candidate edits | `receipts/<attempt-id>.json`, `receipts/<attempt-id>.patch`, `evaluation/<attempt-id>/verdict.json` under the campaign root | Same layout under each repeat root |

**Attempt IDs** have the form `<agent>-<scenario>-<repeat>-<workflow>`, for example `codex-cross-service-2-canary` or `claude-single-service-1-plain`. In each `attempts/<attempt-id>/`:

- `session.jsonl` is the primary native agent transcript; `session-events.json` is its parsed view. `sessions/index.json` maps all captured parent/delegated sessions to `sessions/<session-id>/session.jsonl`. `usage-breakdown.json` separates the recorded usage roles.
- `telemetry-events.jsonl` and `telemetry-summary.json` hold observed request/tool telemetry; `test-executions.jsonl` counts observed Playwright launches. For a plain attempt, `catalog.log`, `inventory.log`, and `checkout.log` are service logs, alongside the runbook and agent output.
- For a Canary attempt, `logs/runs/<attempt-id>/runner.log`, `playwright.log`, `svc-*.log`, `lifecycle-events.jsonl`, `heal-index.md`, and `diagnosis-journal.md` show the runner and failure context. `agent-terminal.log` captures the interactive agent terminal when present.
- The full `report.md` in each campaign has a direct receipt, patch, transcript, evaluator, telemetry, and usage link for **every attempt**. Use it as the attempt-level index rather than guessing a session ID.

The tracked summaries and reports under `tools/benchmark-study/reports/` are in the repository. The full campaign workspaces and raw transcripts are under **`/private/tmp`** and can disappear during system cleanup; their existence was checked while writing this handoff. The [report index](../tools/benchmark-study/reports/README.md) lists the earlier pilot campaigns. No raw campaign is copied into this document.

## Appendix A — matched pairs

All rows below are independently verified successes. Times are repair seconds; tokens include cached traffic. These are the individual observations behind the means, so a later analysis can inspect outliers without treating a group average as every attempt's result.

| Round | Agent | Issue | Repeat | Plain time | Canary time | Plain tokens | Canary tokens |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Original | Codex | single-service | 1 | 151.0 | 105.5 | 628,767 | 881,232 |
| Original | Codex | single-service | 2 | 113.6 | 92.7 | 628,768 | 997,737 |
| Original | Codex | cross-service | 1 | 161.2 | 166.1 | 745,991 | 1,311,161 |
| Original | Codex | cross-service | 2 | 196.3 | 108.0 | 803,610 | 935,199 |
| Original | Claude | single-service | 1 | 153.1 | 41.7 | 704,544 | 267,349 |
| Original | Claude | single-service | 2 | 139.7 | 40.1 | 449,813 | 218,903 |
| Original | Claude | cross-service | 1 | 165.4 | 143.4 | 671,367 | 1,117,344 |
| Original | Claude | cross-service | 2 | 240.3 | 112.8 | 900,551 | 904,903 |
| Codex repeat | Codex | single-service | 1 | 152.1 | 97.7 | 638,757 | 743,785 |
| Codex repeat | Codex | single-service | 2 | 134.0 | 103.4 | 591,835 | 954,703 |
| Codex repeat | Codex | cross-service | 1 | 193.0 | 112.0 | 785,273 | 927,092 |
| Codex repeat | Codex | cross-service | 2 | 167.3 | 174.9 | 634,568 | 1,280,160 |

Canary was slower in one of four Codex pairs in each round. The raw, unrounded values and aggregate calculations are in the two `summary.json` files above.

## Appendix B — earlier campaigns and exclusions

These answer related but different questions. **Do not pool them** with the latest full-loop study or silently replace their historical outcomes.

| Campaign | Recorded result | Why it stays separate | Evidence |
| --- | --- | --- | --- |
| Original 16-attempt pilot | Codex: Canary 4/4, plain 4/4. Claude: Canary 3/4, plain 4/4; one Canary attempt timed out at a local-read permission prompt. Successful Canary pairs were faster. | Earlier permissions and CLI service-management friction affected outcomes. Its evidence collector was audited without rerunning agents. | [Pilot readout](../tools/benchmark-study/reports/canary-pilot-20260928-high-v7/analysis.md) · [token attribution](../tools/benchmark-study/reports/canary-pilot-20260928-high-v7/token-attribution.md) · [pre-audit report](../tools/benchmark-study/reports/canary-pilot-20260928-high-v7/pre-audit-report.md) |
| Opus cross-service permission-corrected follow-up | All four attempts passed the original seven journeys. Frozen additional-check evaluator: Canary 1/2, plain 2/2; review labels the second Canary additional check **inconclusive** because a one-cent rounding rule was not specified. Canary used 2,326,405 recorded tokens versus 1,191,870 plain; 39.0% of Canary tokens belonged to diagnosis agents. | Different campaign and an ambiguous hidden check. Its raw evaluator receipt remains unchanged. | [Follow-up readout](../tools/benchmark-study/reports/canary-opus-cross-permissions-20260928-v2/analysis.md) · [token attribution](../tools/benchmark-study/reports/canary-opus-cross-permissions-20260928-v2/token-attribution.md) · [HTML readout](../tools/benchmark-study/reports/canary-opus-cross-permissions-20260928-v2/readout.html) |
| Scripted local replay, before/after wait optimization | With fixed known repairs and **zero model tokens**, original Canary averaged 8.280 s versus plain 2.341 s; after the readiness/signal change, Canary averaged 6.146 s versus plain 2.317 s. Both 40-attempt campaigns passed 40/40. | Measures local orchestration overhead, not agent reasoning or live repair performance. Installed behavior was not verified by `canary-apply` in that work. | [Replay report](../tools/benchmark-study/reports/canary-comparison-20260928-204119/README.md) · [optimization report](../tools/benchmark-study/reports/canary-fast-waits-20260928/README.md) |
| Prepared 80-attempt study | **0/80 executed.** It was superseded by the user-approved 16-attempt live study. | A prepared manifest is not an observed result. | [Preparation record](../tools/benchmark-study/reports/canary-full-loop-live-20260928/README.md) |

## Appendix C — questions for the next analyst

Use the receipts, patches, logs, and transcripts to test explanations rather than inferring them from means alone:

1. In the successful pairs, how much time was spent on diagnosis, service control, tests, and repeated model turns? Compare the **same agent and scenario**, and keep request telemetry's coverage limits visible.
2. Does Canary's diagnosis delegation account for the added Codex token traffic? Inspect `sessions/index.json` and `usage-breakdown.json`; the benchmark does not isolate delegation from Canary's other features.
3. Why did plain Claude launch Playwright 41 times across four attempts versus eight with Canary? Inspect the plain transcripts and service logs for repeated test runs, restart trouble, or broader edits before attributing the difference to structured failure context.
4. Which findings survive a new repository, explicit rounding requirements, more repetitions, and measured setup/maintenance cost? The present study cannot answer those questions.

Source chats: `01a0e6b5-3ba9-7712-84ca-fc9727de78e7` established the pilot and follow-up context; `01a0e7ca-75b4-7de2-acb8-3e41496ba0cb` contains the local replay, latest live full-loop study, and user-requested Codex repeat. The saved campaign artifacts above are the result authority when chat wording and raw receipts differ.
