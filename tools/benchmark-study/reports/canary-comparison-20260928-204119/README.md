# Canary versus plain — 2026-09-28 rerun

Status: local replay complete; live cloud-agent study prepared and awaiting explicit payload/destination approval following automatic approval review rejection.

## Verified checks

- Benchmark tests: 33 passed across 9 files.
- Benchmark TypeScript check: passed.
- Final replay: 40/40 independent verified successes; 10 repetitions per scenario/workflow, seed 42.
- Live study: 0/80 executed; planned gpt-6-sol and claude-opus-5-5, both high effort.

## Local replay results

These are average attempt elapsed times. Both workflows apply a known frozen repair; no model reasoning occurs and model-token usage is zero. These timings do not establish live agent speed or token savings.

| Scenario | Canary | Plain | Verified repairs |
| --- | --- | --- | --- |
| single-service | 8.271s | 2.342s | 10/10 each |
| cross-service | 8.289s | 2.340s | 10/10 each |

- [Final replay HTML report](/private/tmp/canary-comparison-20260928-204119/replay-final/report.html)
- [Final replay Markdown report](/private/tmp/canary-comparison-20260928-204119/replay-final/report.md)
- [Final replay machine-readable report](/private/tmp/canary-comparison-20260928-204119/replay-final/report.json)
- [Prepared live study](/private/tmp/canary-comparison-20260928-204119/live/study.json)
- [Campaign protocol and provenance](/private/tmp/canary-comparison-20260928-204119/campaign.json)

An initial replay at `/private/tmp/canary-comparison-20260928-204119/replay` is retained as preliminary evidence and excluded from these results because live-study preparation overlapped part of its execution. The final replay started after all preparation finished.

The pending live run will transmit synthetic storefront code, tests, logs, and prompts to OpenAI and Anthropic using the existing CLI accounts; usage cost is unmeasured. Automatic approval review requires explicit approval of those payloads and destinations before execution.

## Performance follow-up

The readiness/signal optimization and its separate 40-attempt replay are recorded in the [2026-09-28 performance follow-up](../canary-fast-waits-20260928/README.md). Canary averaged 6.146s after the change, compared with 8.280s in this original campaign; both campaigns retained 40/40 verified repairs. The original results above remain unchanged. The prepared live campaign is frozen to the older source and needs fresh preparation before testing the new implementation.
