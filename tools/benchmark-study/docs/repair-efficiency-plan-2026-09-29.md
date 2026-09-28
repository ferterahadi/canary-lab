# Repair efficiency implementation and experiment plan

**Status: Phase 0 and experimental Phase 1 implemented locally, 2026-09-29; local validation passed.** The user authorized implementation in a follow-up chat. See the [implementation evidence](../reports/repair-efficiency-20260929/README.md). New live attempts and default promotion remain pending. First reduce duplicate diagnosis; retain runner-owned restart and verification. Then measure context, effort, and local execution changes independently.

Current source inspected at revision `9b95d8111ae6e30d7ad7c0c4850edecb1ceeb19c`. The historical live benchmark used revision `4fb1cc21cf26c9afc53a54faee6003323bcae652` plus its recorded dirty-tree digest. A new experiment must freeze its own source and dependency fingerprints; neither revision alone identifies an experimental binary.

## 1. Evidence and limits

The [handoff](benchmark-study-handoff-2026-09-28.md), [original report](../reports/canary-full-loop-live-16-20260928/README.md), and [Codex repeat](../reports/codex-repeat-20260928/README.md) record the baseline. The handoff was moved under the study directory; its historical relative links have not been repaired as part of this plan. Use the direct report links here.

| Agent/workflow | Original mean repair time | Original mean tokens | Fresh repeat time / tokens |
| --- | ---: | ---: | ---: |
| Plain Codex | 155.5 s | 701,784 | 161.6 s / 662,608 |
| Canary + Codex | 118.1 s | 1,031,332 | 122.0 s / 976,435 |
| Plain Claude | 174.6 s | 681,569 | Not repeated |
| Canary + Claude | 84.5 s | 627,125 | Not repeated |

**Observed:** all 16 original and eight repeated attempts passed independent verification. Each table mean contains four attempts. Canary's Codex advantage repeated at about 24% less repair time, with about 47% more token traffic. Canary was slower in one of four matched Codex pairs in each round. Repair time excludes the independent evaluator; total evaluator times were 14.822 s and 8.951 s respectively.

**Observed in native session evidence:** diagnosis children used 2,261,956 of 4,125,329 Canary Codex tokens in the original round (54.8%), and 2,049,006 of 3,905,740 in the repeat (52.5%). These values were recomputed from the final cumulative counter once per unique session, identifying the primary session separately. Approximately 91% of total Canary Codex traffic was cached input. Child usage is not removable savings: a parent handling the same investigation would incur additional work.

**Observed duplicate work:** original attempt `codex-single-service-1-canary` spawned three children for J2, J4, and J5. All three final answers proposed the identical discount calculation in checkout's `total()`. Children consumed 562,764 of 881,232 tokens (63.9%). This is evidence for testing grouped diagnosis, not proof of its performance.

**Observed baseline friction:** latest-study transcripts `claude-single-service-1-plain` and `claude-cross-service-2-plain` report denied process-control commands, stale services, repeated suite launches, and recovery through alternative process/port arrangements. They also show broader app changes and extra confirmations. The original four plain Claude attempts launched Playwright 41 times versus eight for Canary. The difference cannot be attributed solely to diagnostic context or model reasoning.

Raw evidence, checked while preparing this document:

- `/private/tmp/canary-full-loop-live-16-20260928/attempts/`
- `/private/tmp/canary-codex-repeat-single-20260928/attempts/`
- `/private/tmp/canary-codex-repeat-cross-20260928/attempts/`

Each attempt's session index maps primary/child transcripts; parsed child answers are in `sessions/<session-id>/session-events.json` and native counters in `sessions/<session-id>/session.jsonl`. These temporary directories can disappear. Preserve evidence through the existing study artifact process before launching new work; never make repository tests depend on these personal workspaces.

**Unmeasured:** causal savings, dollar cost, onboarding and maintenance cost, provider-independent latency, broad reliability, and behavior on unfamiliar repositories. This is one synthetic storefront with two scenarios and two repetitions per original combination. Do not pool providers or the earlier pilot/replay studies.

## 2. Current mechanisms and implementation scope

Existing mechanisms must remain the baseline: bounded errors and exact failure slices, failure deltas and journal tails in [heal-index.ts](../../../apps/web-server/src/features/runs/logic/runtime/heal-index.ts); targeted verification in [run-verdict.ts](../../../apps/web-server/src/features/runs/logic/runtime/run-verdict.ts); selective restart in [restart-planner.ts](../../../apps/web-server/src/features/runs/logic/runtime/restart-planner.ts); compact later-cycle guidance in [heal-task-wait.ts](../../../apps/web-server/src/mcp/heal-task-wait.ts). These are not missing features.

The [readiness/signal optimization report](../reports/canary-fast-waits-20260928/README.md) records a zero-token replay improvement from 8.280 s to 6.146 s. Current [run-service-boot.ts](../../../apps/web-server/src/features/runs/logic/runtime/run-service-boot.ts) contains the short initial readiness polling interval. Do not propose this already implemented optimization again. Installed UI/client proof remained pending in that report.

### Phase 0 — make the experiment attributable

**Current → proposed:** two workflow labels and aggregate repair usage → explicit variant identity, parent/child/reviewer usage, and timestamped stage accounting.

In-scope components:

- [types.ts](../types.ts), [prepare.ts](../prepare.ts), [design.ts](../design.ts), [study.ts](../study.ts): add optional variant metadata and immutable configuration digests; generate balanced multi-arm blocks with unique attempt IDs. Preserve historical manifests and their meanings. Extend the existing scheduler rather than disguising variants as plain/Canary or adding a second campaign engine.
- [agents.ts](../agents.ts), [worker.ts](../worker.ts), [telemetry.ts](../telemetry.ts), [report.ts](../report.ts): attribute sessions to parent/child/reviewer, retain unknown classifications, capture the measurements below, and report variant adherence. Child parentage must come from native metadata/launch evidence, not directory order. Approval review stays separately attributed.
- [study.test.ts](../study.test.ts), [design.test.ts](../design.test.ts), [telemetry.test.ts](../telemetry.test.ts), [README.md](../README.md): pin backward compatibility, deduplication, missing-usage handling, balanced ordering, preserved failures, and measurement definitions using synthetic fixtures.

First audit the saved 24 attempts without model calls. Existing usage breakdowns group diagnosis with repair; new reporting should expose the distinction without rewriting historical receipts. Record unavailable data as unknown. Phase 0 is complete when native totals still reconcile and the report identifies every included or missing session.

### Phase 1 — replace mandatory per-failure delegation experimentally

**Current → proposed:** one read-only child per failing test, up to five → parent-first diagnosis for overlapping/simple failures, delegation for independent investigations.

The first implementation is a frozen prompt policy, not an automatic root-cause classifier. The parent reads the existing index, associates failures with evidence-supported candidate causes, and keeps a complete failure-ID ledger. Sharing a service log alone does not establish a common cause. For the measured J2/J4/J5 case, one checkout discount hypothesis can account for all three assertions. Unrelated failures remain separate.

Three policies: current per-failure control; parent-only diagnosis; adaptive diagnosis with at most two concurrent children initially. The adaptive policy permits a child only for a distinct unresolved investigation after the parent's index pass. The parent applies patches serially, reconciles overlap, and signals once. Every failure remains addressed or explicitly unresolved. A child cannot edit, signal, or declare verification complete. Further escalation is allowed after contradictory evidence or a failed verification cycle, and must be recorded as an escalation rather than silently changing the arm.

In-scope surfaces:

- [heal-agent.md](../../../apps/web-server/prompts/heal-agent.md) and [auto-heal.ts](../../../apps/web-server/src/features/runs/logic/runtime/auto-heal.ts): render the chosen diagnosis policy through the existing prompt loader. Keep service-mode guardrail placeholders and the zero-editable-repository mode boundary intact.
- [external-heal-surface.ts](../../../apps/web-server/src/features/runs/logic/heal/external-heal-surface.ts), [mcp-repair-instructions.md](../../../apps/web-server/prompts/mcp-repair-instructions.md), and [portify.ts](../../../apps/web-server/src/mcp/tool-groups/portify.ts): align next-step guidance and the failure-detail tool description with the same policy. Despite its filename, the latter currently describes per-failure diagnosis fan-out.
- Discover every shipped run-skill mirror before editing with `rg -n 'per failure|per-failure|sub-agent' agent-integrations --glob SKILL.md`. Update the canonical Claude source and byte-identical Codex/plugin mirrors together. Do not alter unrelated authoring, portification, or coverage delegation policies.
- Extend [auto-heal.test.ts](../../../apps/web-server/src/features/runs/logic/runtime/auto-heal.test.ts), [repair-guardrail.test.ts](../../../apps/web-server/src/mcp/repair-guardrail.test.ts), and applicable existing surface tests. Pin policy agreement and repair restrictions, not only word counts.

Keep the production default unchanged during screening. Pass variant configuration through the study adapter and existing prompt-rendering path; freeze the rendered prompt digest. A policy violation stays visible in its assigned arm. Report both assigned-policy outcomes and adherence; do not silently remove noncompliant attempts.

### Phase 2 — reduce duplicated context independently

**Current → proposed:** client-dependent inherited context and repeated overlapping reads → explicit bounded investigation packets for children that are still needed.

Use the same files as Phase 1, plus [heal-prompt-map.ts](../../../apps/web-server/src/features/runs/logic/runtime/heal-prompt-map.ts) if the map needs a reusable packet reference. A packet contains failure IDs, exact slice/error paths, editable roots, applicable requirements, repair restrictions, and expected evidence-plus-patch output. Set an initial proposed summary budget of 1,500 tokens, excluding referenced source files. Preserve complete artifacts and permit justified expansion; truncating evidence must never turn an unknown into a conclusion.

Compare the selected Phase 1 policy with current child context versus fresh bounded context, holding delegation policy constant. Verify support for fresh child context in each pinned client before claiming the arm exists. If unsupported, test bounded task/output content only and label inherited context unchanged. Never bypass required workspace instructions or permissions. Reuse an existing helper/loader instead of a second spawn implementation.

Only add shared investigation records to the index/journal if the offline audit shows repeated reads that the existing delta and journal tail do not prevent. Such a record must distinguish evidence from hypotheses and identify its cycle/source revision. This extension is a separate future ablation, not bundled into the context test.

### Phase 3 — optional effort and launch experiments

- **Effort:** high effort everywhere → lower effort for bounded diagnosis with explicit escalation. Use [agent-models.ts](../../../apps/web-server/src/features/agent-sessions/logic/agent-models.ts) and the existing [agent-process.ts](../../../apps/web-server/src/features/agent-sessions/logic/agent-process.ts). Keep model identity fixed first; changing models is another experiment. The current evidence collector checks every repair session against one model/effort pin: introduce explicit frozen role-specific pins and validate each session against its assigned role before testing mixed effort. Do not disable pin validation. Report escalation usage. Do not reduce [agent-context-policy.ts](../../../apps/web-server/src/features/agent-sessions/logic/agent-context-policy.ts) window limits as a substitute for reducing task work: compaction can add work.
- **Launcher:** shell/npx invocation → direct locally resolved Playwright executable for supported configurations, retaining a compatibility fallback. [run-spawn.ts](../../../apps/web-server/src/features/runs/logic/runtime/run-spawn.ts) still invokes `npx playwright test`. The earlier listing-only profile measured roughly 0.78 s versus 0.21 s direct. This is not a full-loop measurement. Validate environment hydration, PATH for child commands, executable/version resolution, cancellation and artifacts before live testing. Use the existing [replay.ts](../replay.ts) and runtime integration tests first.

Neither optional change proceeds until earlier experiments establish which work remains expensive. Their benefit and engineering effort are unmeasured.

## 3. Ablation matrix and execution order

All live campaigns require a separate concrete execution approval with frozen payloads, destinations, pins, attempt count and exposure. This document does not launch them. Existing authorization for historical campaigns does not authorize these new variants.

| Order | Comparison | Fixed settings | Proposed screening size |
| --- | --- | --- | ---: |
| 0 | Offline attribution and local regressions | Existing receipts; no model calls | Existing 24 attempts |
| 1 | A: current fan-out; B: parent-only; C: adaptive | Codex model/high effort; same evidence and runtime | 2 scenarios × 5 blocks × 3 arms = 30 |
| 2 | Winning delegation policy: current vs bounded child context | Same model/effort/delegation policy | 2 × 5 × 2 = 20, only if children remain |
| 3a | High vs lower diagnosis effort | Same model/context/policy | 2 × 5 × 2 = 20, optional |
| 3b | Existing vs direct launcher | Fixed known patch, no inference | 2 × 10 × 2 = 40 local replay attempts |
| 4 | Frozen current Canary vs combined candidate | Codex pins; fresh runs, no tuning | 2 × 10 × 2 = 40 confirmation attempts |
| 5 | Transfer: current Canary vs candidate | Claude separately, then an unfamiliar repo | Separately designed and approved |

Use independently randomized, balanced arm order within scenario/repetition blocks; execute adjacent arms serially to avoid resource contention. Freeze seed, source/dependency digests, model/effort/CLI pins, scenario snapshots, protected-file rules, permissions, runtime commands, test selection, artifact capture and deadlines. Equalize cache preparation policy; record cache counters rather than claiming cache equivalence. Never prefill one arm with answers from another. Use new workspaces and session IDs.

Five blocks per scenario are a screening choice that improves on two observations while limiting exposure; they are not a power calculation. Freeze selection rules before screening. Confirmation uses fresh runs to reduce winner-selection bias. Estimate variance from screening, then determine whether ten confirmation blocks per scenario can resolve the practical targets; if not, propose a larger fixed sample before starting confirmation. Do not keep adding attempts until a desired result appears. Show scenario-stratified paired estimates and uncertainty; the existing pair-only interval helper must be adapted to resample whole multi-arm blocks for screening. Small samples cannot establish reliability parity or stable p95 latency.

### Time and usage exposure

These are planning estimates, not quotas or measured future outcomes. At 122 s and 976,435 total native tokens per current Canary Codex attempt:

| Campaign | Baseline-rate repair estimate | Token traffic estimate | Repair timeout ceiling at 15 min/attempt |
| --- | ---: | ---: | ---: |
| Delegation, 30 attempts | 61 min | 29.3 million | 7.5 h |
| Each 20-attempt ablation | 41 min | 19.5 million | 5 h |
| Confirmation, 40 attempts | 81 min | 39.1 million | 10 h |
| Core path: 30 + 20 + 40 | 183 min | 87.9 million | 22.5 h |

Preparation, preflight, independent evaluation, analysis and implementation add time. These traffic estimates include cache and do not predict bills. If parent-only wins, skip the child-context comparison; the core then has 70 attempts. Adding effort screening makes 110 attempts before transfer. Transfer sizing, monetary cost, and engineering duration remain unmeasured. Before execution, choose an explicit monetary/usage ceiling using the approved account's actual pricing; a wall-clock timeout does not bound tokens. Stop dispatching new attempts when that ceiling is reached, preserve active-attempt evidence, and use the existing cancellation path if the approved hard cap requires interruption.

## 4. Measurement contract

| Metric | Definition |
| --- | --- |
| Repair time | Existing worker-start through execution return boundary in study.ts, including setup, startup, diagnosis, edits, tests, retries, session/artifact capture and cleanup. Keep this historical metric unchanged. |
| Time to independent verdict | New monotonic timestamp from attempt dispatch to independent evaluator completion, including intervening orchestration. Record separately from repair time plus evaluator duration so gaps remain visible. An unsuccessful attempt has no successful-repair time; retain its elapsed time and outcome. |
| Critical path | Timestamped non-overlapping elapsed stages: setup/boot, initial test, agent diagnosis/edit, signal/restart/readiness, verification cycles, capture/cleanup, evaluator. During delegated work report the parent waiting interval and child spans without adding overlapping durations. Missing boundaries stay unknown. |
| Codex traffic | Sum final input + output once per unique native session. Cached input is already inside input. Uncached input = input − cached input when both are available and consistent; never subtract cache twice. |
| Claude traffic | Deduplicate native message IDs across captured logs; sum input + output + cache reads + cache writes. Report every component separately. |
| Attribution | Primary repair, diagnosis children, approval-review sessions, and unclassified/missing sessions. Missing required usage makes the aggregate unknown rather than zero. |
| Outcomes | Independent success, failure, timeout, interrupted, infrastructure error or contamination, with all attempts retained. Protected-file changes invalidate success. |
| Supporting evidence | Child count, duplicated file reads/proposed patches, model turns where observable, context bytes, escalations, repair cycles, launches, service restarts, human intervention and policy adherence. Bytes are not tokens. |

Request telemetry is partial and may overlap. Never derive local time by subtracting request-duration sums. Provider, network and queue variation remain part of observed elapsed time. Report successful-pair timing alongside all assigned attempts' outcomes and total consumed usage; do not create an apparent win by dropping failures or expensive invalid attempts. Dollar cost needs verified pricing/account data and is a separate calculation.

## 5. Verification, acceptance and rollback

### Independent evidence stays authoritative

- Preserve [evaluator.ts](../evaluator.ts) as the success authority, with the original seven journeys and frozen additional checks on fresh app state. Define requirements, including rounding, before execution. Never silently revise an evaluator after observing results.
- Agents repair application code only. Do not weaken, delete, skip or loosen tests, assertions, helpers, requirements, dependencies, protected configuration or evaluator checks. Preserve the existing protected-file and isolation checks, and retain failed/invalid patches.
- A signal requests runner verification; a child answer or parent hypothesis does not establish success. Keep one editing/signalling owner. Preserve not-run/skipped distinctions, authoritative pass counts, lifecycle events, artifacts and missed-event recovery. Targeted development verification does not replace the independent full verification.

### Proposed gates, fixed before launch

| Gate | Promote when | Stop or reject when |
| --- | --- | --- |
| Instrumentation | Native totals reconcile; variant/prompt digests, session roles and boundaries are auditable | Missing or inconsistent counters, mutable inputs, ambiguous variant identity; fix collection before performance claims |
| Screening | At least 20% lower mean total tokens than current Canary; mean repair time no more than 5% worse; no new observed independent failures | Any integrity violation stops the campaign; any candidate failure pauses further candidate dispatch for investigation and stays in results |
| Combined confirmation | At least 20% fewer mean total tokens and 10% lower mean time to independent verdict; no observed success regression; no scenario mean latency regression over 5% | Targets missed, material tail/outlier regression, or effect uncertainty still includes meaningful harm: retain current default and report inconclusive/failed gate |
| Installed adoption | Required local, package and live UI/agent checks pass; transfer results support intended scope | Stale state, contradictory client guidance, restart/cancellation regression, or unsupported client context control |

The percentages are practical targets, not observed savings or statistical significance. Report uncertainty and each scenario independently. If confirmation is underpowered, collect an independently approved fixed follow-up or keep the feature experimental. Zero failures in these small samples is not proof of equal reliability.

Pause on source/CLI drift, isolation failures, protected-file edits, repeated infrastructure failure, exhausted approved exposure, or a human stop. Retain interrupted attempts; never replace them invisibly. Do not widen permissions automatically to rescue one arm. Before continuing after a bug fix, prepare a new fingerprinted campaign and keep old results separate.

Rollback means selecting the original diagnosis/context/launcher policy for new runs. Active runs retain their recorded policy to avoid changing their contract mid-repair. Preserve all receipts and artifacts. A failed candidate must not force an application rollback or erase its evidence.

### Implementation validation and ownership

The implementer follows the repository's code/reuse, prompt, evidence, MCP-tool and agent-surface skills. Enumerate semantic surfaces again at implementation time; this file list is an inspected starting point. Run scoped regression tests, build typecheck, conventions/boundaries checks, and documentation checks. Prompt/shipped-asset changes also require the tarball smoke test. Run-loop changes require the real storefront MCP claim → wait → fix → signal → wait loop.

New policy/progress/evidence state must use the existing store/event ownership path and recover missed changes. Apply the live-state and WebSocket skills; verify already-open UI and connected agent consumers without refresh or re-opening. Do not add a new UI configuration surface merely for the benchmark; if a product setting is later needed, scope and route it separately.

The user owns `canary-apply` unless an applicable local opt-in skill exists when implementation occurs. Local/source checks and installed behavior must be reported separately. The experiment operator obtains approval for each concrete live campaign; the analyst reports all outcomes and decides only against the predeclared gates.

## 6. Risks and alternatives

- **Incorrect grouping:** same symptoms can have different causes. Keep failure coverage explicit; split a group when evidence conflicts. Parent-only is the simpler alternative; current fan-out remains useful for genuinely independent failures.
- **Lost context:** fresh children may miss requirements or permissions. Carry mandatory instructions and source paths; record expansions. Bounded output with inherited context is an alternative when fresh context is unsupported.
- **Slower complex repairs:** fewer children can lengthen the critical path. Evaluate cross-service and unfamiliar-repository cases separately; do not adopt a global policy on a single simple-case win.
- **Benchmark-specific gains:** preserve historical plain comparisons, but add a separate baseline with process-control commands demonstrably usable across tool calls. That isolates lifecycle friction; it must not overwrite the 41-launch Claude observation.
- **Small local gains with compatibility cost:** direct launch can break shell/environment expectations. Keep it optional unless full-loop gains justify support burden. Additional test pruning, unconditional cache tricks, automatic root-cause classifiers and lower context caps are outside the first implementation.

Next action: obtain execution approval for the [prepared 30-attempt campaign](diagnosis-screening-campaign-2026-09-29.md). Until that experiment finishes, lower token use and faster verified repairs remain hypotheses.
