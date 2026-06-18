---
name: cl_scope-the-ask
description: Use the moment a request is vague or open-ended — "improve the cleanup UI", "make this better", "clean this up", "let's polish X", "can we redo Y" — where the WHAT is named but the specific change is not. Stops the reflex to fire an AskUserQuestion menu guessing the goal; instead look at the target first, then ask one open question or wait for the user to point at the real thing. Applies to any Canary Lab work (UI, run loop, MCP, docs), not just UI.
---

# Scope the ask before offering options

A vague opener — "improve the cleanup UI", "make X nicer", "let's clean this
up" — is an invitation to **look**, not a cue to generate a menu of directions.
The user almost always has a specific thing in mind. Your job is to surface
*their* ask, not to make them react to *your* speculation.

## The trap

The reflex is to immediately fire an `AskUserQuestion` with 3–4 options —
"Visual polish? / Disk insight? / Faster bulk? / New capability?" — to look
proactive. This backfires:

- It forces the user to engage with your guesses instead of just stating their
  goal. The fastest path to their intent is the one where they talk, not where
  they pick from your list.
- The real ask is frequently *none of the options* (in the session this skill
  came from, the user wanted "click a run id → open that run" — not on any of
  the four offered tiles).
- It reads as not having looked. A menu of plausible directions is what you
  write *before* understanding the surface, and the user can feel that.
- It contradicts the standing **recommend, don't ask** preference: when you do
  have enough to act, lead with a decisive pick, not an options buffet.

A dismissed question is the signal you jumped early. Don't re-ask a reworded
menu — back off and let them lead.

## What to do instead

1. **Look at the target first.** Read the component / module they named (and how
   the rest of the app does the equivalent) so you understand it before saying
   anything. Often this alone reveals the obvious improvement.
2. **Then pick exactly one:**
   - **Ask one open question** — "What's bugging you about it?" / "What do you
     want it to do that it doesn't?" Open, not multiple-choice. One message.
   - **Or just wait / state intent and pause.** Users opening vague usually have
     a concrete thing they'll reveal in their next message — sometimes by
     clicking the exact element. Give them the room.
3. **Only then,** once the concrete goal is on the table, do the normal design
   pass (propose an approach, recommend, confirm scope).

## When AskUserQuestion IS the right tool

Use it for a **genuine fork that changes what you build** and that you can't
settle from the code or sensible defaults — and where each option is real, not a
guess at the goal:

- "Clicking a run id leaves the page and jumps to the workspace, *or* opens it in
  a new tab — which behavior?" (two concrete implementations, both viable)
- "Auth via session cookie or JWT?" (a decision only the user can make)

The test: **am I choosing between known alternatives, or fishing for the goal?**
Fishing → don't use it. Choosing → use it, lead with your recommendation.

## Example (the session this came from)

Input: "i want to make improvement to the cleanup ui"

- ❌ What I did: fired a 4-option menu (polish / disk insight / bulk / new
  capability). Dismissed — none matched.
- ✅ What worked: look at `LogCleanupPage`, then let the user point. They clicked
  the run-id cell: "bring me to the actual run." Concrete, instantly actionable.

The cost of guessing wrong was a wasted round-trip; the cost of looking + waiting
was nearly zero.
