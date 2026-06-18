---
name: cl_reuse-shared-logic
description: Use the moment you're about to add code or UI that resembles something already in the repo — a second agent spawn, a second pill/card/dialog, a second background store, a second stream parser, a second timeout. Before writing a near-copy, find the existing one and either reuse it or extend it into a shared helper/component/primitive. Captures Canary Lab's "related logic has one home" rule and the primitives that already exist.
---

# Canary Lab — Reuse Over Duplication

Related logic gets **one home**. Before adding a block that resembles an existing
one, find that one and reuse it — or extend it into a shared
helper/component/primitive that every site calls. A near-copy with a few lines
tweaked is a smell: the variants drift, and the same bug has to be fixed N times
(it has happened here — idle timeouts, stream-json, and answer-recovery were each
added to *some* agent spawns and not others, and the same SIGTERM bug recurred).

## The tell

If you're about to copy a block and change 2–3 lines, **stop**. That block wants
to be a function/component whose 2–3 differences are parameters. "It's only
slightly different" is how five slightly-different copies are born.

## Primitives that already exist — reuse, don't re-invent

| Concern | The one home | Don't |
| --- | --- | --- |
| Colour / spacing / radius / type | CSS tokens + layout precedents → `cl_ui-design-philosophy` | hardcode hex, add a UI kit |
| Long-running background task | file-backed store pattern → `cl_async-task-ux` | bespoke job tracking |
| Idle / liveness timeout | `startIdleTimer` (`lib/agent-idle-timer.ts`) | inline `setInterval` + `lastOutputAt` |
| Recover claude's answer from stream-json stdout | `recoverClaudeFinalText` (`lib/agent-stream.ts`) | re-parse envelopes inline |
| Path of claude's session JSONL | `claudeSessionLogPath` (`lib/agent-session-log.ts`) | recompute `~/.claude/projects/...` |
| Show an agent's progress/output | `AgentSessionView` + `tailAgentSession` → `cl_surfacing-agent-work` | a new viewer |
| MCP tool surface | `mcp/tools.ts` registry → `cl_add-mcp-tool` | a parallel tool path |

## Known open debt — the agent-process runner

There are **six** near-identical "spawn agent CLI → pipe stdout → tee to
log/`onOutput` → bump the idle clock → handle cancel → recover the answer" blocks:

- `lib/wizard-agent-runner.ts`
- `lib/coverage/annotate-engine.ts`
- `lib/coverage/prd-summary.ts`
- `lib/test-review-export.ts`
- `lib/runtime/portify/agent.ts`
- `lib/runtime/benchmark/runner.ts` (sabotage)

They drifted and the same fixes (idle, stream-json, stdout-bump) had to be applied
six times. They should be **one** `runAgentProcess(...)` primitive:

- **Shared core:** spawn; pipe + tee stdout/stderr; bump idle on every chunk;
  `startIdleTimer` with the session-JSONL-growth backstop; the claude agentic
  argv (`-p --dangerously-skip-permissions --output-format=stream-json
  --include-partial-messages --verbose [--session-id|--resume]`) via one
  `buildClaudeAgenticArgs` builder.
- **Per-caller adapters (params):** output sink (`onOutput` vs logfile vs both),
  final-answer handling (`recoverClaudeFinalText` vs `--output-last-message` file
  vs none), cancellation source (registry vs `AbortSignal` vs `children` set),
  return shape (string vs void).

Until that lands, **any change to one spawn must be applied to all six** — and
that recurring pain is the reason to consolidate them.

## Rule

- Adding a spawn/tee/idle block → use (or extend) the shared runner; don't copy.
- Adding a claude argv → use the shared arg builder; don't re-list the flags.
- Adding a UI surface → `cl_ui-design-philosophy`. Background task → `cl_async-task-ux`.
- When the shared thing doesn't *quite* fit, **extend it with a parameter** — do
  not fork a copy. If extending would make it a god-function, split a small shared
  core with thin adapters (see the runner sketch above), still not copies.
