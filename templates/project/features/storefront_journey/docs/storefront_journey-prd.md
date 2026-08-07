# Storefront journey requirements

The demo proves seven customer journeys across three services. Five are pairs of
**ordered contracts**: if the first fails, the test stops and the second has not
been established yet. Keep them in this order — a failed upstream contract must
never be rounded into proof of a downstream one.

Two journeys (J0 and J6) are sound and pass from the first run. They are not
padding: a suite in which everything fails cannot show that the harness reports
what it finds rather than repairing whatever it touches.

## J0 — Listing what was created

Creating a product returns it at the price given, and it appears in the catalog
listing.

## J1 — Buying in-stock items

1. **Catalog identity.** Creating `Espresso Beans` at 1800 cents returns a
   product whose stable SKU is `espresso-beans`.
2. **Inventory consumption.** That SKU identifies inventory. Reserving two units
   reduces the available count by exactly two.

## J2 — Discount codes

1. **The discount reaches the total.** Two units at 1800 cents with `WELCOME10`
   total 3240 cents.
2. **Codes replace, never stack.** Applying `HALFOFF` to the same cart replaces
   the earlier code, totalling 1800 cents — not a combined 60% off.

## J3 — Refusing an oversell

1. **The refusal is honest.** Reserving more than is available returns 409 and
   reports the count that is genuinely still available.
2. **Unknown stock is a missing resource.** Reserving against a SKU that does
   not exist is refused with 404, not 400.

## J4 — Repricing

1. **A price change persists.** Updating a product's price returns the product
   at its new price.
2. **Reads agree with charges.** Reading a cart back reports the same total
   checkout will charge, discount included.

## J5 — Removal and rejection

1. **A deleted product is gone.** Deleting a product removes that product — and
   only that product — from the catalog listing.
2. **A rejected code changes nothing.** An unknown discount code is refused with
   400 and leaves the discount already on the cart intact.

## J6 — Refusing an empty order

Placing a cart with no items is refused with 409 and the cart stays open.

## Scope

These twelve contracts and their ordering are the whole feature; ten of them
start broken and two are sound. The services carry
other input-validation and not-found responses so they are realistic small APIs;
apart from the unknown-SKU reservation named in J3, those defensive branches are
fixture support, not acceptance requirements — do not turn them into separate
tests or coverage obligations.

Contracts must also be **stateless across reruns**. These services hold their
data in memory and are not restarted between heal cycles, so a contract whose
evidence accumulates (a leaked reservation, a growing counter) drifts every
cycle and eventually breaks its own setup.

Each journey must be one ordered Playwright test that exposes only the earliest
broken contract, so a repair agent sees one defect at a time and each repair
reveals the next.
