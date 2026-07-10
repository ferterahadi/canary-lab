---
name: cl_reuse-shared-logic
description: Use the moment you're about to add code or UI that resembles something already in the repo — a second agent spawn, a second pill/card/dialog, a second background store, a second stream parser, a second timeout. Before writing a near-copy, find the existing one and either reuse it or extend it into a shared helper/component/primitive. Captures Canary Lab's "related logic has one home" rule and the primitives that already exist. Skip when the code is genuinely one-of-a-kind or the resemblance is superficial (same shape, different concern); for styling questions use cl_ui-design-philosophy and for background-task lifecycle use cl_async-task-ux.
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
| **Spawn an agent CLI** (claude/codex) | `runAgentProcess` + `buildClaudeAgenticArgs` (`agent-sessions/logic/agent-process.ts`) | re-implement spawn + tee + idle |
| Idle / liveness timeout | `startIdleTimer` (`agent-sessions/logic/agent-idle-timer.ts`) | inline `setInterval` + `lastOutputAt` |
| Recover claude's answer from stream-json stdout | `recoverClaudeFinalText` (`agent-sessions/logic/agent-stream.ts`) | re-parse envelopes inline |
| Path of claude's session JSONL | `claudeSessionLogPath` (`agent-sessions/logic/agent-session-log.ts`) | recompute `~/.claude/projects/...` |
| Show an agent's progress/output | `AgentSessionView` + `tailAgentSession` → `cl_surfacing-agent-work` | a new viewer |
| MCP tool surface | `mcp/tools.ts` registry → `cl_add-mcp-tool` | a parallel tool path |

## The agent-process runner (consolidated — keep it that way)

**Every** agent-spawn site composes `runAgentProcess`
(`apps/web-server/src/features/agent-sessions/logic/agent-process.ts`) instead of
re-implementing "spawn → pipe stdout → tee → bump idle → cancel → recover answer".
Current sites, as of 2026-07 (relative to `apps/web-server/src/features/`; the
grep below is the source of truth over this list — re-run it, don't trust the
list alone: `grep -rln runAgentProcess apps/web-server/src --include='*.ts' | grep -v '\.test\.'`):

- `wizard/logic/wizard-agent-runner.ts`, `coverage/logic/coverage/annotate-engine.ts`,
  `coverage/logic/coverage/prd-summary.ts`, `evaluation/logic/test-review-export.ts`,
  `portify/logic/runtime/agent.ts`, `benchmark/logic/runtime/runner.ts` (the
  benchmark's sabotage agent), `flights/logic/stages/context.ts`

The primitive owns the shared core: spawn; pipe + tee stdout/stderr; bump the idle
clock on every chunk; `startIdleTimer` with the session-JSONL-growth backstop. The
claude agentic argv comes from `buildClaudeAgenticArgs`. Each caller passes only
its differences as params/closures: `onChunk` (sink), `captureStdout`, `stdin`
(codex `-`), `activityPath`, `onIdle`/`onTick`, and maps `handle.done` to its own
return shape + cancellation source (registry / `AbortSignal` / `children` set).

**Rule:** a new agent feature, or any change to spawn/idle/stream behaviour, goes
through `runAgentProcess` / `buildClaudeAgenticArgs` — never a fresh copy. If the
runner can't express a need, add a param to it.

## Rule

- Adding a spawn/tee/idle block → use (or extend) the shared runner; don't copy.
- Adding a claude argv → use the shared arg builder; don't re-list the flags.
- Adding a UI surface → `cl_ui-design-philosophy`. Background task → `cl_async-task-ux`.
- When the shared thing doesn't *quite* fit, **extend it with a parameter** — do
  not fork a copy. If extending would make it a god-function, split a small shared
  core with thin adapters (see the runner sketch above), still not copies.
