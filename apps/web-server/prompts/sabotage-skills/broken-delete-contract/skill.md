# Silent contract violation

**Level:** medium destruction

## Description

Make an operation report success while leaving incorrect state. Keep the cause
visible only in the service log, not the browser or trace.

## Sabotage instructions

To benchmark repair, make one operation **lie**: return success while a write,
update, or delete fails to persist correctly.

Requirements:

- the app still compiles and boots;
- the operation returns its normal success response, so the browser and the
  trace both see "OK";
- a test that checks the *resulting state* fails;
- keep (or add) a server-side log line for the operation so the discrepancy
  (request logged, state wrong) is visible in the service log — not the browser.

Skim the tests first to find a state-changing operation they verify. Make the
change, then stop. Do not add comments that reveal the bug.

## Constraints

- Edit **only** application / service code.
- **Never** edit the e2e / test specs — the tests are the fixed specification.
- Do not touch feature config, envsets, or the Playwright config.
