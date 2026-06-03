# Silent contract violation

**Level:** medium destruction

## Description

Break an operation's contract so the response still looks successful, but the
underlying state or data is wrong. The root cause is only visible in the service
log — not the browser or the trace — which is exactly where structured failure
context earns its keep.

## Sabotage instructions

You are deliberately breaking this app to benchmark an AI repair loop. Make one
operation **lie**: it should still return a success status / response, but its
underlying side effect must be wrong — e.g. a write / update / delete that
responds "OK" yet doesn't actually persist (or persists the wrong thing).

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
