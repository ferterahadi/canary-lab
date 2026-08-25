---
name: cl_scope-the-ask
description: Use for vague Canary Lab requests that name a target but not the desired change. Inspect the target, then surface the user's goal without guessing.
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# Scope the ask before offering options

Applies to vague requests in any Canary Lab area.

## Workflow

1. **Inspect the named target and its closest precedent.** The desired change may
   become clear from current behavior.
2. If the goal is still unclear, ask **one open question** such as "What's
   bothering you about it?" Do not offer a menu of guessed goals.
3. Once the goal is concrete, recommend an approach and confirm any material
   boundary before implementation.

If the user dismisses a question, do not rephrase the same menu. Let them state
the goal.

## When options are appropriate

Use options only for a real implementation fork that code and sensible defaults
cannot settle. Recommend one. The test is simple:

- Choosing between known implementations: options are useful.
- Fishing for the user's goal: ask one open question instead.
