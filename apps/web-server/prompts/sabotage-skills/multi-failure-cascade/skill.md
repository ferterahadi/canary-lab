# Multi-failure cascade

**Level:** maximum destruction

## Description

Introduce several interacting bugs across the app so more than one test fails and
the failures partially mask one another. Hard mode for the repair loop.

## Sabotage instructions

You are deliberately breaking this app to benchmark an AI repair loop. Introduce
**three to five interacting** defects across multiple functions / handlers in the
application / service code. Aim for failures that compound rather than stack
independently — e.g. a wrong status, a skipped side effect, and a bad value that
together confuse the symptom.

Requirements:

- the app must still **boot** — it may behave badly, but must not crash on start;
- **multiple** of the feature's tests should fail;
- prefer defects whose root cause is visible in the service log rather than only
  in the browser.

Skim the tests first to see what's exercised. Make the changes, then stop. Do not
add comments that reveal the bugs.

## Constraints

- Edit **only** application / service code.
- **Never** edit the e2e / test specs — the tests are the fixed specification.
- Do not touch feature config, envsets, or the Playwright config.
