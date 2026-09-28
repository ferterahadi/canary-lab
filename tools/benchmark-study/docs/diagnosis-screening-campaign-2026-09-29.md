# Diagnosis-policy screening campaign

**Prepared, not executed.** 30 attempts are ready; zero attempts or paid preflights have run. This campaign needs execution approval before calling `run`.

## Frozen design

- Codex only: `gpt-6-sol`, high effort, `codex-cli 0.158.0`. The manifest also records Claude's installed pin for compatibility; no Claude attempt is scheduled.
- Two storefront scenarios × five blocks × three policies: `per-failure`, `parent-only`, `adaptive`.
- Seed 29, balanced arm positions; each block runs adjacent arms serially in fresh workspaces.
- Fifteen-minute repair timeout per attempt. Independent evaluation retains all seven journeys and additional frozen checks; protected-file edits invalidate success.
- Production default stays per-failure. Children remain read-only. The parent applies patches and signals. Semantic adherence requires transcript review; it is not inferred from child counts.

## Payloads and destinations

- [Study manifest](/private/tmp/canary-diagnosis-screening-20260929/study.json) — complete schedule, CLI executables, tool restrictions, snapshots, dependency versions and digests.
- [Prepared report](/private/tmp/canary-diagnosis-screening-20260929/report.html) — 0/30 recorded; pending observations are unknown.
- Input demo: `/private/tmp/canary-study-20260928-high/demo-project`. Preparation copied its files; it did not repair the demo.
- Attempt workspaces and logs: `/private/tmp/canary-diagnosis-screening-20260929/attempts/`.
- Independent verdicts: `/private/tmp/canary-diagnosis-screening-20260929/evaluation/`; receipts and retained patches: `/private/tmp/canary-diagnosis-screening-20260929/receipts/` (created during execution).
- Agent requests use the existing authenticated Codex CLI account. Runtime preflight and diagnosis prompts are sent to that provider; optional browser MCP, inherited connectors, plugins, hooks and memory are disabled by the frozen tool policy. Native session logs use the configured client home and are copied into each attempt's evidence.
- Every cycle stores its actual rendered prompt, hash and byte count under `attempts/<id>/prompts/`; the prepared template digests below exclude only runtime-specific substitutions.

| Fingerprint | SHA-256 |
| --- | --- |
| Configuration | `865d8410f47b044db5af5bb3b0b870c0bd673bcf3ad4c3654cb5db48cef365f0` |
| Source | `cf8dc986f6b6a625a03d9411a0e9817cf33c5a1f6d0a2112f153dd05895c992f` |
| Dependencies | `b1a314af03a2b4f8ccaac20a9d1580b6f1fe39fc90584300c5fa4258ec5c5b4a` |
| Scenario/suite inputs | `aa6ce2dd46e8afeb0765b0e77cb58d1bdf8c8c6b447d18a71ba3cc6f8b54cd77` |
| Prompt: per-failure | `00531534651423c4aaf007cf411775da4e12e3eb2e0d0db21abc48864dfa5a45` |
| Prompt: parent-only | `413e6670ea28ad8ccabb499de5e5653426a1b758db03977df04051b1c25a40ed` |
| Prompt: adaptive | `ac7ffe2e76788e2daf67caa4ccd5f1e6a2092b9c5c99a9eeba33f034d629d47b` |

## Proposed exposure and stopping rules

The proposed threshold is **35,000,000 total native tokens**, including cache traffic, plus the explicitly accepted possibility of an in-flight overshoot. It is a dispatch ceiling: after each completed attempt, no further attempt starts if recorded preflight plus attempt usage reaches the threshold. Missing usage also stops dispatch. There is no hard token or monetary cap and no verified dollar estimate. A runtime preflight or active attempt can exceed the threshold before its final native counter is available.

Historical baseline rates imply roughly 61 minutes of repair time and 29.3 million native tokens for 30 attempts. Preparation, preflight, independent evaluation and analysis add time. These are planning estimates from a small synthetic sample, not a cost guarantee; the repair timeout ceiling is 7.5 hours plus surrounding work.

Any unsuccessful attempt stops further dispatch and remains in the results. Investigate and prepare a new fingerprinted campaign after a failure; do not silently replace it. Source/CLI/input drift also blocks execution. Stop on human request. No permission widening or automatic default promotion is authorized.

Screening targets remain predeclared: at least 20% lower mean native tokens, mean repair time no more than 5% worse, and no new observed independent failures. Report all assigned outcomes and scenario-stratified complete-block uncertainty. Five blocks per scenario cannot establish reliability parity. Later context, effort, launcher and confirmation experiments need their own designs.

## Execution after approval

Approval must cover the 30 attempts, existing account/provider, frozen payloads and destinations, and the dispatch-only exposure limit above. If a hard monetary/token cap is required, do not run this campaign until an enforceable mechanism is defined.

```sh
npm run benchmark:study -- run --study /private/tmp/canary-diagnosis-screening-20260929
```

[Implementation and validation evidence](../reports/repair-efficiency-20260929/README.md)
