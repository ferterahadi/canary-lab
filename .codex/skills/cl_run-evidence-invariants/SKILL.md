---
name: cl_run-evidence-invariants
description: Use when touching anything that produces or reports a run's verdict — pass/fail counts, result parsing, heal prompts and modes, run artifacts and retention, evaluation exports, or coverage math. The rules that keep Canary Lab's output evidence rather than an agent's self-report.
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# Run Evidence Invariants

Canary Lab's whole value is that a verdict is **grounded in things the agent didn't
author**: the harness runs the tests, counts come from real result lines, coverage is
computed from tags, and repairs change the app. Break one of these and the product
still *works* — it just stops being trustworthy, silently. That's why these live as
invariants rather than review taste. Source of intent:
[docs/PRD.md](../../../docs/PRD.md) — Problem + Quality bars.

Use this alongside `cl_sync-agent-surfaces` (which keeps the *prose* about these rules
in agreement across agent surfaces). This skill is about the *code* that produces the
evidence.

## 1. The repair rule — fix the app, not the test

**An agent may never delete, skip, weaken, or loosen an assertion to turn a run
green.** A test edited into passing is the exact failure this product exists to catch.

- Spawned auto-heal: the directive lives in `MODE_COPY` in
  `apps/web-server/src/features/runs/logic/runtime/auto-heal.ts` — `service` mode says
  "Fix service/app code, not tests." Pinned by `auto-heal.test.ts`.
- External/MCP: `REPAIR_INSTRUCTIONS` (`mcp/server.ts`) + the shipped
  `canary-lab-run` skills. Pinned by `mcp/repair-guardrail.test.ts`.
- **The one deliberate exception**: auto-heal's `test` mode, selected by
  `detectHealMode` only when the run has **zero editable repos** (`repoPaths` empty) —
  the spec is then the only fixable code. On any read error it defaults to `service`,
  and it must stay that way. Never widen this to a feature that has app code.
- `dirtyTests` is an **awareness signal**, not an error: relay the message verbatim,
  never block/revert/re-run on it, and never edit test files to clear it.

## 2. Honest counts

- Read passes from `result.counts.statusLine` / `result.counts.passed` / `summary.passed`.
- **Never compute `total - failed`.** That silently converts never-run tests into
  passes — the single most consequential rounding-up available to a reporting agent.
- A test absent from `passedNames`, `failed`, and `skippedNames` is **not run**, not
  passed. Preserve that distinction in every summary, UI tile, and export.
- Coverage % is computed by canary from the tags (covered ÷ active total), never
  asserted by an agent. One computation layer behind both the UI and
  `get_feature_coverage` — don't recompute it in a second place.

## 3. Evidence durability

- Run artifacts under `logs/runs/<runId>/` (logs, traces, summaries, journal) are
  **never auto-pruned** — removal is manual Log Cleanup only. Don't add a TTL, a
  rolling cap, or a "tidy up old runs" convenience.
- Service output is captured programmatically (PTY/tee), never left to a terminal
  the user has to still have open.
- Every external command is audited per run. Journal entries are concise and factual.

## 4. Exports preserve status

- A failed or aborted run exports **as-is**. Never heal first, never soften the
  status in the wording, never drop/merge/dedupe cases to make the report read better.
- **The case list mirrors the DECLARED roster, not the executed set.**
  `buildTestReviewPacket`
  (`apps/web-server/src/features/evaluation/logic/test-review-export.ts`) enumerates
  `summary.knownTests` — Playwright's own reporter walk of the whole suite, taken
  before the first test starts — and keeps that order. A test the run never reached is
  **present and labelled `NOT_RUN_STATUS` (`'not run'`)**: never dropped, and never
  rounded into a pass or a fail. A 23-test suite that stopped at the failure limit
  after 6 reports **23 cases with 17 marked never-run**; building the roster from
  `playbackEvents` instead silently reports it as a 6-test suite.
  - Anything the run actually reported that the roster misses is **appended, not
    discarded** — evidence is never dropped in either direction.
  - Status conflicts resolve **downward**: a per-test playback verdict beats the
    summary lists, and failed/skipped are checked before passed.
  - Runs recorded before the reporter emitted `knownTests` have none — those **fall
    back to the executed set**, which is all the evidence that exists for them.
  - Pinned by the `declared-test roster` describe block in
    `apps/web-server/src/features/evaluation/logic/test-review-export.test.ts`.
- External export wording is **client-authored**; Canary renders and stores it, and
  never agent-generates or rewrites the report content.

## Before you claim a change here is safe

1. Did you change how a verdict is *derived*? Then a unit test must pin the new
   derivation against a real fixture, not a hand-built object.
2. Did you touch prompt/instruction prose carrying rule 1 or 2? Run
   `npx vitest run apps/web-server/src/mcp apps/web-server/src/features/runs/logic/runtime/auto-heal.test.ts`
   and then `cl_sync-agent-surfaces` for the surfaces that must agree.
3. Did you change the run loop's observable behavior? Tier 4 in `cl_verify-changes` —
   drive `demo_catalog` end to end and read the counts off a real result.

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| Deriving passed as `total - failed` "because the list is right there" | Never-run tests silently become passes — the product's core claim breaks |
| Widening auto-heal `test` mode beyond zero-editable-repos | The agent is told to edit specs on a feature that has app code — sanctioned test-weakening |
| Softening the repair rule's wording in a prose cleanup | It's a guardrail, not copy; the guardrail tests exist because prose is deletable |
| Adding artifact retention limits | Evidence the user expected to still be there is gone; runs stop being independently checkable |
| Healing a failed run before exporting it | The export now describes a run that didn't happen |
