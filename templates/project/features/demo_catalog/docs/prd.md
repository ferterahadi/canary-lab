# demo_catalog — Product Requirements

The source PRD for the Verified Coverage Ledger. Edit this file and regenerate the
summary — in the UI via the Coverage tab's Docs rail (the **Generate** button), or
over MCP via `start_external_summary` → `submit_external_summary` — requirement ids
are preserved across regeneration.

The service these requirements describe is `demo-app/catalog-service`.

## Add a product
A `POST /products` with a `name` and a `price` adds the product to the catalog,
returns its generated id, and stores the price it was given. A request with no
name is rejected (negative path).

## List the catalog
`GET /products` returns every product that has been added, in the order they were
added, each with its current price.

## Reprice a product
`PATCH /products/:id` changes a product's name or its price and returns the
updated product. A repriced product must report its new price on the next read —
recording the request without changing the price would mean shoppers are quoted
one figure and charged another. A reprice to a price that is not a positive
number is rejected (negative path). No test claims that negative path yet —
included to show a requirement whose happy path is covered but whose declared
sad path is not.

## Remove a discontinued product
`DELETE /products/:id` removes the product so it no longer appears in the
catalog. Removal should be confirmable from an independent read of the list, not
only from the response to the delete itself.

## Search the catalog
Shoppers should be able to find a product by name without paging through the
whole catalog. (Not yet implemented or tested — included to show an untested
requirement.)
