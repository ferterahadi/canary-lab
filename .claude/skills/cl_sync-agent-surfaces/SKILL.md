---
name: cl_sync-agent-surfaces
description: Use after changing run-loop semantics — collision/queue choices, boot sessions, heal claims, signal/rerun rules, pass-count rules — or when auditing whether MCP instructions, tool results, and the shipped SKILL.md files still agree.
---

# Syncing Canary Lab's Agent-Facing Surfaces

External agents learn the run loop from five surfaces that nothing keeps in sync
automatically. A semantic change to one must land on all five, or skill-less clients
and skill-carrying clients diverge. Background: [docs/ARCHITECTURE.md →
Keep-in-Sync Invariants](../../../docs/ARCHITECTURE.md#keep-in-sync-invariants).

## The five surfaces

| # | Surface | File |
| --- | --- | --- |
| 1 | Profile instructions (`INSTRUCTIONS_BY_PROFILE`) | `apps/web-server/mcp/server.ts` |
| 2 | Tool-result steering (`healWaitNext`, `bootSessionValue`, collision/queued result shapes) | `apps/web-server/mcp/tools.ts` |
| 3 | Claude skill (full 14-step run loop + authoring) | `agent-integrations/claude/skills/canary-lab/SKILL.md` |
| 4 | Codex skill (identical to #3 except `client_kind: "codex-cli"`/`"codex-desktop"`) | `agent-integrations/codex/skills/canary-lab/SKILL.md` |
| 5 | Plugin skill (deliberately condensed loop) | `agent-integrations/plugin/canary-lab/skills/canary-lab/SKILL.md` |

**Condensation rule for #5**: keep the run-loop steps, guardrails, and pass-count
rules; drop authoring/export detail. Do not paste the full Claude skill in.

## Semantics that must agree everywhere

- Collision choice: `repo_collision_requires_choice` → ask the user → re-call with
  `isolation: "worktree"` or `"queue"`; never guess.
- Queueing: `queued: true` + `queueReason`; `wait_for_heal_task` still blocks.
- Boot-only sessions: `type: "boot_session"` / `executionType: "boot"` → no heal
  claim, no waiting, `abort_run` (confirm) stops services.
- Heal-claim policy: denylist — only runner-spawned PTY agents (`claude-pty`/
  `codex-pty`) get `claimSuppressed: true`; interactive Claude/Codex clients
  (Desktop or CLI) can claim.
- Waiting: block on `wait_for_heal_task`; never poll `get_run_snapshot`/`get_run`.
- Verification after a fix: `signal_run` (with `hypothesis` + `fixDescription`),
  never a fresh `start_run`.
- Pass counts: `result.counts.statusLine` / `counts.passed`; never `total - failed`;
  tests absent from all lists are *not run*.
- `start_run` is the single start/resume/restart entrypoint; omit
  `run_ref`/`force_new` to continue a healing run.

## Sync procedure

1. State the semantic change in one sentence (e.g. "queued runs now report ETA").
2. For each surface 1–5, find where the old semantic is expressed:
   `grep -rn '<keyword>' apps/web-server/mcp/server.ts apps/web-server/mcp/tools.ts agent-integrations/`
   (useful keywords: `repo_collision_requires_choice`, `boot_session`, `queued`,
   `claimSuppressed`, `statusLine`, `wait_for_heal_task`, `isolation`).
3. Update each hit; for #4 preserve the codex `client_kind` values, for #5 apply the
   condensation rule.
4. Tick a 5-row checklist in your working notes — a surface with zero grep hits for
   a semantic that should appear there is a *finding*, not a pass.
5. Verify: `npx vitest run apps/web-server/mcp` and read the three SKILL.md diffs
   side by side.

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| Updating instructions but not tool results (or vice versa) | Skill-less clients follow results, skill-carrying clients follow prose — they diverge |
| Copying the Claude skill verbatim into the plugin skill | Plugin skill balloons; the condensation was intentional |
| Forgetting the codex variant "because it's identical" | It's identical *except* client kinds — a verbatim copy breaks claim detection |
