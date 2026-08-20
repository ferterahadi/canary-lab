# Multi-failure cascade

**Level:** maximum destruction

## Description

Introduce interacting bugs that fail several tests and partly mask one another.

## Sabotage instructions

To benchmark repair, introduce **three to five interacting** defects across
application or service functions. Make them compound, such as corrupted data that
another bug mishandles, rather than fail independently.

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
