---
name: cl_verify-the-premise
description: Use before acting on an unverified code claim, bug report, known gap, or assumption that several implementations behave alike.
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# Verify the Premise, Not Just the Mechanism

Plans, follow-ups, and bug reports are hypotheses. Confirm the reported behavior
against today's code before changing it.

## Check

- Reproduce the observable problem, not only the proposed mechanism.
- Search for existing handlers, events, refetch paths, or alternate names.
- Before treating several implementations alike, open every one and find the
  lifecycle or ownership differences.

If evidence disproves the premise, **stop and report that evidence. Do not build a
second path.** A plausible, tested fix can still be unnecessary.

## Warning signs

- A plan is your only proof that something is missing.
- You verified an internal mechanism but not the user-visible failure.
- You explain an existing solution away as redundant or legacy.
- You assume all instances match without opening them.

Complements [[cl_verify-changes]], which verifies the result after a change.
