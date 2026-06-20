---
name: cl_add-mcp-tool
description: Use when adding, removing, renaming, or moving an MCP tool between profiles in apps/web-server/mcp/tools.ts, or when the MCP smoke test fails with a tool-count or unknown-tool mismatch.
---

# Adding or Moving a Canary Lab MCP Tool

A tool change touches a sync triangle: the profile arrays in `tools.ts`, the mirror
arrays in the smoke test, and (sometimes) the agent-facing instructions. The mirror
arrays are the #1 forgotten step. Background: [docs/ARCHITECTURE.md → MCP Layer +
Keep-in-Sync Invariants](../../../docs/ARCHITECTURE.md#keep-in-sync-invariants).

## Checklist

1. **Implement as a thin wrapper** in `apps/web-server/mcp/tools.ts`. Reuse the REST
   route via `app.inject()` — never duplicate orchestrator logic. Author-profile
   tools call `apps/web-server/src/features/orchestration/logic/feature-authoring.ts` directly.
2. **Add the name to the `CanaryLabMcpToolName` union** (top of `tools.ts`).
3. **Add to exactly one profile array** — `REPAIR_TOOLS`, `VERIFY_TOOLS`,
   `AUTHOR_TOOLS`, or `FULL_ONLY_TOOLS` (`tools.ts:240–307`). A tool may appear in
   several workflow arrays if it genuinely belongs to several workflows
   (e.g. `list_features`). `FULL_TOOLS` auto-dedupes the union — never edit it.
   `registerCanaryLabTools` throws at registration if a tool is in no profile.
4. **Mirror the name in `apps/web-server/mcp/server.smoke.test.ts`** — the test
   keeps its own copies of the profile arrays so SDK shape changes are caught.
   Update every array you touched in step 3.
5. **Destructive tool?** Gate on `confirm: z.literal(true)` in the input schema
   (pattern: `abort_run`, `write_envset`).
6. **Run-following tool?** Append `nextSteps` via `healWaitNext` so result-driven
   agents block on `wait_for_heal_task`, and handle boot-only runs with
   `bootSessionValue`/`isActiveBootRun` so they don't dead-wait.
7. **Decision gate**: does the change alter run-loop *behavior* an external agent
   sees (new result shape, new next step, changed semantics)? If yes → invoke
   `cl_sync-agent-surfaces` before finishing.
8. **Verify**: `npx vitest run apps/web-server/mcp/server.smoke.test.ts`, then the
   full suite per `cl_verify-changes`.

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| Skipping the smoke-test mirror arrays | Smoke test fails with a tool-count mismatch — or silently passes with stale coverage if you also "fixed" the count |
| Editing `FULL_TOOLS` directly | It's computed; the edit is dead code and the next reader is misled |
| Duplicating route logic inside the tool | Drifts from the REST behavior (admission, collision, envset apply all live in the route) |
| New result shape without updating instructions/skills | External agents invent their own loop — that's the bug `INSTRUCTIONS_BY_PROFILE` exists to prevent |
