---
name: cl_sync-agent-surfaces
description: Use after changing run-loop semantics — collision/queue choices, boot sessions, heal claims, signal/rerun rules, pass counts, or the fix-the-app-not-the-test repair rule — or when auditing whether MCP instructions, tool results, and the shipped agent skills still agree.
---

# Syncing Canary Lab's Agent-Facing Surfaces

External agents learn the run loop from surfaces that **nothing keeps in sync
automatically**. A semantic change to one must land on all of them, or skill-less
clients and skill-carrying clients diverge. Background: [docs/ARCHITECTURE.md →
Keep-in-Sync Invariants](../../../docs/ARCHITECTURE.md#keep-in-sync-invariants).

Skip for pure tool add/remove/rename/profile-move with no semantic change →
`cl_add-mcp-tool`.

## Discover the surfaces — never work from a memorized list

The shipped skill set grows, and **the run loop has already moved between files**:
it lives in `canary-lab-run/SKILL.md`, *not* the umbrella `canary-lab/SKILL.md`
(which is now the flight-pipeline conductor). Any hardcoded file list in a doc —
including an older version of this one — goes stale silently and sends you to edit
files that no longer carry the semantic.

Enumerate every time, before you edit anything:

```bash
find agent-integrations -name SKILL.md | sort           # every shipped skill file
grep -rln '<semantic keyword>' agent-integrations --include=SKILL.md
```

**The grep is the authority, not this document.** Re-derive the file count every
time; never trust a number written here.

## The surface map

| # | Surface | Where | Owns |
| --- | --- | --- | --- |
| 1 | Profile instructions + workflow guides (`INSTRUCTIONS_BY_PROFILE`, `WORKFLOW_GUIDES`) | `apps/web-server/src/mcp/instructions.ts` over `apps/web-server/prompts/mcp-*-instructions.md` | The lead above `<!-- initialize-cut -->` (≤ 2048 chars) is what a skill-less client reads at `initialize`; the whole file is what `get_workflow_guide` returns |
| 2 | Tool-result steering (`healWaitNext`, `bootSessionValue`, collision/queued shapes) | `apps/web-server/src/mcp/heal-task-wait.ts` (helpers) + `tool-groups/` (call sites) | What a result-driven agent follows next |
| 3 | Shipped run-loop skills | `canary-lab-run/SKILL.md` in all three channels (locate them with the grep) | The full external loop: claim → wait → fix → signal |
| 4 | Other shipped skill families | `canary-lab{,-verify,-author,-coverage,-portify,-export}/SKILL.md` | Touch only when the changed semantic is theirs — grep decides |

Channel differences to preserve when editing #3/#4:

- **codex** — the `SKILL.md` is a **byte-identical copy** of the Claude one,
  `type: skill` frontmatter included. Codex-specific addressing lives in the
  sibling `agents/openai.yaml` (only the codex channel has it) — never touch
  that file when syncing a semantic. Procedure: edit the Claude file, then
  copy it over the codex one (`cp`), keeping `agents/openai.yaml` in place.
- **plugin** — also a **byte-identical copy** of the Claude file (confirm with
  `diff -q` before you start). Same procedure: edit the Claude file, then `cp`
  it over the plugin one.
- Key phrases are pinned across all three mirrors by `apps/cli/agent.test.ts`
  ("instructs agents to verify fixes with signal_run…") — run it after syncing.
- Neither skill passes `client_kind` — the bridge auto-detects it from the connection.

## Semantics that must agree everywhere

**The repair rule comes first — it is the product's reason to exist.**

- **Fix app/service code, not tests, unless a test is provably wrong.** An agent may
  never delete, skip, weaken, or loosen an assertion to turn a run green. A run that
  goes green because the test stopped checking is the exact failure Canary Lab exists
  to catch (see [docs/PRD.md](../../../docs/PRD.md) — Problem, and quality bar 1).
  The one deliberate exception is auto-heal's `test` mode, which activates only when a
  feature has **zero editable repos**, so the spec is the only fixable code — see
  `cl_manage-prompts`. Never widen that exception to a feature that has app code.
  Enforced by `apps/web-server/src/mcp/repair-guardrail.test.ts`.
- **Pass counts**: `result.counts.statusLine` / `counts.passed`; never `total - failed`;
  tests absent from all result lists are *not run*, not passed.
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
- `start_run` is the single start/resume/restart entrypoint; omit
  `run_ref`/`force_new` to continue a healing run.

## Sync procedure

1. State the semantic change in one sentence (e.g. "queued runs now report ETA").
2. **Enumerate the surfaces with the two commands above.** Do not start from a list.
3. Grep for where the old semantic is expressed across code + shipped skills:
   ```bash
   grep -rn '<keyword>' apps/web-server/src/mcp/ agent-integrations/
   ```
   (useful keywords: `repo_collision_requires_choice`, `boot_session`, `queued`,
   `claimSuppressed`, `statusLine`, `wait_for_heal_task`, `isolation`, `provably wrong`)
4. Update every hit, preserving the channel differences above.
5. Tick a checklist with **one row per file the grep returned** — a file that should
   express the semantic and has zero hits is a *finding*, not a pass.
6. Verify: `npx vitest run apps/web-server/src/mcp` (includes the repair-guardrail test),
   then read the changed SKILL.md diffs side by side.

## Common mistakes

| Mistake | Consequence |
| --- | --- |
| Working from a hardcoded surface list | You edit the umbrella `canary-lab` skill while the run loop in `canary-lab-run` stays stale — the exact drift this skill exists to prevent |
| Updating instructions but not tool results (or vice versa) | Skill-less clients follow results, skill-carrying clients follow prose — they diverge |
| Rewording the repair rule "for clarity" | It's a guardrail, not copy. Weakened wording is how "fix the app" quietly becomes "make it green" |
| Hand-editing the codex `SKILL.md` independently | It must stay a byte copy of the Claude file — edit Claude, then `cp`; codex identity lives in `agents/openai.yaml`, not the frontmatter |
