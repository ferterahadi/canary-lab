---
name: cl_verify-the-premise
description: Use the moment you're about to act on a claim about the code you didn't confirm yourself — a plan/spec/"follow-up" item, a "known gap", a bug report ("doesn't update live", "only works after refresh", "isn't wired", "X is missing"), or a "these N are identical, migrate them the same way" assumption. Any "fix X" where you haven't watched X actually fail right now.
---

# Verify the Premise, Not Just the Mechanism

A plan, spec, follow-up item, or bug report is a **hypothesis about the code**,
not ground truth. It was written earlier, by someone (maybe you) reasoning about
the code rather than running it. Before you build the fix, confirm the premise is
still true by observing the **current behavior**. The code is the only authority.

## The trap (it bites careful agents)

You verify the *mechanism* the claim describes — "the store's `onEvent` listeners
are dead" — find it accurate, and build the fix. But you never checked the
*premise* — "the UI doesn't update live" — which was already **false**, because a
different layer (route-level `publishWorkspaceEvent`) handled it. You ship a real,
fully-tested, completely unnecessary change.

## The rule

Before acting on "X is broken / missing / not wired / identical", answer one
question **with the code**: is X actually true *right now*?

- "Doesn't update live" → trigger the mutation, find the existing event/refetch path FIRST.
- "These N are identical" → open all N. One is always different (a runner writes it; the third uses free functions).
- "X is missing" → grep for it. It's often already there under another name or layer.
- Premise turns out false? **STOP. Report it with proof. Do not build.** "Already handled — here's where" beats a plausible unnecessary feature every time.

## Premise vs mechanism

| Question | Checks | The mistake |
|---|---|---|
| **Premise** | Is the stated problem real *now*? | Skipped — assumed true because the plan said so |
| **Mechanism** | Does the code work the way the claim describes? | Verified *instead* → confirms a non-problem in detail |

Verifying the mechanism feels like diligence. It isn't, if you never asked whether
the problem exists.

## Red flags — STOP, you're acting on an unverified premise

- "The plan says it's not wired, so I'll wire it" — did you watch it fail?
- You found evidence *against* the premise (an existing emit / handler / path) and **explained it away** — "redundant backstop", "legacy", "harmless duplicate" — instead of stopping.
- You're adding a second path that does what an existing path already does.
- "All N are the same" without having opened all N.
- The fix is plausible and fully testable. Unnecessary changes usually are — that's why they pass review.

## Common mistakes

| Mistake | Reality |
|---|---|
| Trusting a "known gap" / "follow-up" item | A hypothesis written earlier, often already wrong. Re-confirm against today's code. |
| Verifying the mechanism, not the premise | The store's events being dead ≠ the UI being stale. Check the observable behavior. |
| Explaining away contradicting evidence | An existing emit/handler IS the answer, not a "redundant backstop". Stop and report. |
| "Migrate all N identically" | Open all N first; the outlier (free functions, a runner-owned writer, a different lifecycle) is where the work — or the bug — hides. |

Complements [[cl_verify-changes]] (verify the *result* after a change). This one
verifies the *premise* before you start.
