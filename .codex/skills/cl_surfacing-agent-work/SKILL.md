---
name: cl_surfacing-agent-work
description: Use when building or changing any UI that shows an agent's progress or output (live or historical), when choosing how to stream agent output, or when a user says an agent view "looks stuck" / "I can't see the output". Prevents designing a viewer before knowing what the agent actually produces.
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# Surfacing an Agent's Work (without overpromising)

Skip when: the view is blank because the session-log path is wrong
(`CLAUDE_CONFIG_DIR`/`CODEX_HOME`, missing JSONL) → `cl_locate-agent-session-logs`;
non-agent UI styling → `cl_ui-design-philosophy`; generic "only updates after
refresh" staleness → `cl_live-state-sync`.

The expensive, repeated mistake on this codebase: **building the viewer before
grounding in the agent's real execution model.** A polished "watch the agent
think / read / work" surface is worthless — and reads as *stuck* — if the agent
behind it is a single completion that produces no such trace. Match the surface to
what the agent actually emits, and tell the user the limits *before* you build.

## Step 0 — classify the agent BEFORE designing anything

Find the spawn and answer one question: **is this an agentic loop or a one-shot
completion?**

| Shape | How to spot it | What it can show |
| --- | --- | --- |
| **Agentic loop** | spawned to read/iterate with tools: the heal agent, **and PRD-summary + coverage-mapping** (their prompts list file paths and make the agent read the docs/specs itself) — long-running, writes tool_use / tool_result / thinking to its session log | A genuine timeline — reads, thinks, tool calls, results, multiple turns |
| **One-shot completion** | A prompt that **inlines all context** and whose observed run makes no tool calls (often the evaluation rewrite). `codex exec` alone does not establish this shape; it can run an agentic loop. | Only the prompt + one final answer when no tools are used. No read/think/tool timeline to show. |

**Don't classify by spawn flags alone.** `claude -p --dangerously-skip-permissions`
already has tools ON — what makes a spawn one-shot *in practice* is a prompt that
inlines every input, so the model never needs to call a tool. PRD-summary +
coverage-mapping prompts list file *paths* and require reading them, so they stream
a real read/think/tool timeline through `AgentSessionView`. The evaluation rewrite
inlines its evidence packet, so it is one-shot.

If it is one-shot, **say so up front** and scope the view to reality. A session
viewer may show only the final block. If the user needs to watch answer text
arrive, use a supported stdout stream; if they need real read/tool steps, give
the task inputs the agent must inspect and verify that it actually uses tools.

## Two transports — pick the one that fits the shape

| Transport | What it is | Good for | Cannot |
| --- | --- | --- | --- |
| **On-disk session JSONL** — `AgentSessionView` tails it (REST snapshot + `/ws/.../agent-session`, parsed by `agent-session-log.ts`) | The agent CLI's own session file; the parser emits **complete events only** | Agentic loops; historical replay; the structured rail (thinking/tool/result rows, model+session header) | **Token-stream a one-shot** — the assistant block only lands at *completion*, by which point the job is done and the view moves on, so you see just the prompt |
| **Claude stdout `--output-format=stream-json --include-partial-messages`** | The live token stream on stdout; parse deltas yourself (see `features/agent-sessions/logic/agent-stream.ts`) | Watching a Claude one-shot write its answer in real time | Give you the structured tool/think rows for free — you render the text. Check Codex's actual output format separately. |

Rule of thumb: **agentic loop → AgentSessionView (file tail). Claude one-shot
whose answer must stream → stream-json stdout → a live log.** For Codex, inspect
the CLI output this spawn actually uses before choosing a streaming view. The file
tail physically cannot show token partials (the JSONL records whole blocks, and the
shared parser drops partial lines). See [[cl_ui-design-philosophy]] "One agent
timeline everywhere" for when the structured rail IS the right call.

## Honesty / anti-overpromise

- When a user asks to "see what the agent is doing," **answer with the agent's shape
  first**, then build. "These are one-shot inferences — there's no read/think trace;
  the most you can watch is the answer stream in" is the honest framing. Saying it at
  design time is cheap; discovering it after shipping costs a rebuild.
- Don't ship a thinner proxy (a flat `<pre>` log behind a toggle) for the thing the
  user explicitly asked to see and call it done. Either deliver the real view or
  surface the constraint and decide together. A toggle that flips between two equally
  empty states "does nothing".
- Verify the data **exists** before designing the view that displays it. If you can't
  confirm the wire shape locally (e.g. claude's stream-json — needs the user's
  `canary-apply` env), say so, parse defensively, and degrade safely.

## Persist the LIVE lifecycle, not just navigation

A generation/heal job is durable server-side. If the UI shows it, the UI must
**rehydrate the running job on open** (query the job list, re-attach the poller) —
not just restore which view/feature was selected. Persisting navigation but not the
in-flight job is why "refresh during generating loses the state" even though the
header still says *Generating*. One owner for the job lifecycle; every panel reads
it (see [[cl_ui-design-philosophy]] "One owner for a long-lived lifecycle" and
[[cl_async-task-ux]]).

## Common mistakes

| Mistake | Symptom | Fix |
| --- | --- | --- |
| Mounted a tool-loop timeline on a one-shot agent | "1 event", looks stuck | Classify first; stream-json stdout → live log for one-shots |
| Promised "watch it think/read" for an agent with no tools | User bounces twice | State the shape up front; scope the view to it |
| File-tail viewer expected to token-stream | Only the prompt shows until completion, then the view closes | Use stdout stream-json for the live token feel |
| Persisted view+feature but not the running job | Refresh mid-job → empty ledger | Rehydrate the active job on mount |
| Deferred the core "see the agent" ask with a flat-log placeholder | "the toggle does nothing" | Do it properly or surface the real constraint |

## Verify

Stream parsing is pure + unit-tested (`features/agent-sessions/logic/agent-stream.test.ts`) so the logic
is checkable without a live agent; the actual wire shape needs the `canary-apply`
cycle (see `cl_verify-changes` Tier 3). Component behaviour is happy-dom-tested.
