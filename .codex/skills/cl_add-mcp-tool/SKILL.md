---
name: cl_add-mcp-tool
description: Use when adding, removing, renaming, or moving an MCP tool between profiles in apps/web-server/mcp/tools.ts, when sizing what a tool RETURNS into the agent's context, or when the MCP smoke test fails with a tool-count or unknown-tool mismatch.
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# Adding or Moving a Canary Lab MCP Tool

A tool change touches a sync triangle: the profile arrays in `tools.ts`, the mirror
arrays in the smoke test, and (sometimes) the agent-facing instructions. The mirror
arrays are the #1 forgotten step. Background: [docs/ARCHITECTURE.md → MCP Layer +
Keep-in-Sync Invariants](../../../docs/ARCHITECTURE.md#keep-in-sync-invariants).

Run-loop *semantic* changes (collision/queue/heal-claim/pass-count rules) →
`cl_sync-agent-surfaces` instead.

## Checklist

1. **Implement as a thin wrapper** in `apps/web-server/mcp/tools.ts`. Reuse the REST
   route via `app.inject()` — never duplicate orchestrator logic. Author-profile
   tools call `apps/web-server/src/features/config/logic/feature-authoring.ts` directly.
2. **Add the name to the `CanaryLabMcpToolName` union** (top of `tools.ts`).
3. **Add to every workflow array the tool genuinely belongs to (usually one)** —
   `REPAIR_TOOLS`, `VERIFY_TOOLS`, `AUTHOR_TOOLS`, `COVERAGE_TOOLS`,
   `EXPORT_TOOLS`, `FLIGHT_TOOLS`, `PORTIFY_TOOLS`, or `FULL_ONLY_TOOLS` (all in
   `tools.ts`). Cross-workflow tools appear in several arrays (e.g.
   `list_features`). `LIFECYCLE_TOOLS` and `FULL_TOOLS` are both computed
   deduped unions — never edit either (lifecycle = repair + verify + author +
   coverage + export + flight + full_only; full = lifecycle + portify).
   `registerCanaryLabTools` throws at registration if a tool is in no profile.
4. **Mirror the name in `apps/web-server/mcp/server.smoke.test.ts`** — the test keeps
   its **own hand-authored copies** of the eight workflow arrays *plus* its own
   `LIFECYCLE_TOOLS` union (nine authored lists; only its `FULL_TOOLS` is derived), so
   SDK shape changes are caught. Update every array you touched in step 3. The mirror's
   lifecycle union must keep matching `tools.ts` — if you add a tool that lives *only*
   in `REPAIR_TOOLS` or `VERIFY_TOOLS`, check it still does.
5. **Size the result to the agent's token budget, not the transport limit** — see
   below.
6. **Destructive tool?** Gate on `confirm: z.literal(true)` in the input schema
   (pattern: `abort_run`, `write_envset`).
7. **Run-following tool?** Append `nextSteps` via `healWaitNext` so result-driven
   agents block on `wait_for_heal_task`, and handle boot-only runs with
   `bootSessionValue`/`isActiveBootRun` so they don't dead-wait.
8. **Decision gate**: does the change alter run-loop *behavior* an external agent
   sees (new result shape, new next step, changed semantics)? If yes → invoke
   `cl_sync-agent-surfaces` before finishing.
9. **Verify**: `npx vitest run apps/web-server/mcp` (smoke test + repair guardrail),
   then the tiers `cl_verify-changes` calls for.

## Sizing a tool result (the inline-vs-path rule)

An MCP tool result lands **directly in the agent's context window**. The budget is
what the agent can comfortably consume in one call — *not* what the JSON-RPC
transport will carry. 512 KB "fits" the transport and costs ~131K tokens; that's a
huge slice of the window burned on one call.

- Keep inline payloads in the **single-digit KB** range and reason in **tokens**
  (~4 chars/token). `get_failure_detail` uses **8 KB ≈ 2K tokens** as its ceiling.
- Past the budget, return a **path** (plus an `includeRaw` / `includeDiff` /
  `…Path` flag) and let the agent `Read` it with offset/limit — never truncate the
  text mid-stream.
- Don't justify a ceiling as a "pathological / won't-break-the-response guard" —
  that's the wrong mental model and it produces limits 50× too large.

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| Skipping the smoke-test mirror arrays | Smoke test fails with a tool-count mismatch — or silently passes with stale coverage if you also "fixed" the count |
| Editing `FULL_TOOLS` or `LIFECYCLE_TOOLS` in `tools.ts` | Both are computed there; the edit is dead code and the next reader is misled (the *smoke test's* lifecycle union IS hand-authored — that one you do update) |
| Sizing a payload against the transport limit | A single tool call eats the agent's context; the fix is a path, not a bigger inline blob |
| Duplicating route logic inside the tool | Drifts from the REST behavior (admission, collision, envset apply all live in the route) |
| New result shape without updating instructions/skills | External agents invent their own loop — that's the bug `INSTRUCTIONS_BY_PROFILE` exists to prevent |
