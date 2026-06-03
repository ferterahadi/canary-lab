# Subtle logic bug

**Level:** minimal destruction

## Description

Introduce a single, subtle logic bug in one function or request handler so that
exactly one test goes red. The app still compiles and boots; the failure reads
like an ordinary "wrong value" bug.

## Sabotage instructions

You are deliberately breaking this app to benchmark an AI repair loop. Introduce
**exactly one** subtle logic error in a **single** function or request handler in
the application / service code. The change must:

- be small and plausible — a flipped boolean, an off-by-one, a wrong comparison,
  or a dropped / defaulted field — not an obvious deletion or a syntax error;
- keep the app compiling and booting normally;
- cause **exactly one** of the feature's existing tests to fail.

First skim the test files to see what behaviour is checked, then pick a handler
or function those tests exercise and introduce the bug there. Make the change,
then stop. Do not add comments that reveal the bug.

## Constraints

- Edit **only** application / service code.
- **Never** edit the e2e / test specs — the tests are the fixed specification.
- Do not touch feature config, envsets, or the Playwright config.
