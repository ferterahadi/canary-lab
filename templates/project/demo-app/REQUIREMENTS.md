# Storefront journey requirements

The demo proves seven journeys across three services. Five contain **ordered
contracts**: if the first fails, the second remains unproven. Keep this order;
an upstream failure cannot prove a downstream contract.

J0 and J6 pass from the first run. They prove the harness reports actual results
instead of repairing every test.

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

These twelve ordered contracts are the whole feature; ten start broken and two
pass. Other validation and not-found responses make the services realistic but,
except for J3's unknown SKU, are fixture support—not tests or coverage obligations.

Contracts must be **stateless across reruns**. Services keep data in memory between
heal cycles, so leaked state would eventually break test setup.

Each journey must be one ordered Playwright test exposing only its earliest defect;
each repair reveals the next.
