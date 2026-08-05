# Storefront journey requirements

The demo proves exactly one happy-path customer journey across all three
services. Treat these as ordered contracts: if an earlier assertion fails, the
test stops and the later behavior has not been established yet.

1. **Catalog contract.** Creating `Espresso Beans` at 1800 cents returns a
   product whose stable SKU is `espresso-beans`.
2. **Inventory contract.** The catalog SKU identifies inventory. Reserving two
   units reduces the available count by exactly two.
3. **Checkout contract.** Checkout uses the catalog price and successful
   reservation. Two units at 1800 cents with `WELCOME10` total 3240 cents.

The acceptance test must exercise that complete chain through the public HTTP
APIs. Keep the assertions in this order so a failed upstream contract cannot be
rounded into proof of a downstream one.

This feature's requirements are only the three contracts above and their
ordering. The services also contain ordinary input-validation and not-found
responses so they are realistic small APIs, but those defensive branches are
fixture support, not acceptance requirements for this demo. Do not turn them
into separate tests or coverage obligations.

The prerequisite wording describes happy-path sequencing, not a separate sad
path to simulate. One ordered Playwright test should expose only the earliest
broken contract on each run; the next service becomes testable after that
contract is repaired.
