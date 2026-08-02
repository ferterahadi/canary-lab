# Checkout service — what it is supposed to do

Prose on purpose. The requirements stage of a flight reads a document like this
and distils it into numbered requirements that specs can be tagged against, so
coverage can be measured. Leaving it unstructured is what makes that stage
demonstrable.

## Starting a cart

A shopper begins with `POST /carts`. The service returns a new cart with an id,
no items, and a total of zero. The cart is open until it is checked out.

## Adding items

`POST /carts/:id/items` takes a `sku`, a `unitPrice` and an optional `quantity`
(defaulting to one) and appends the line to the cart. The response carries the
updated cart and its running total. A request missing either the sku or the unit
price is rejected.

## Applying a discount

`POST /carts/:id/discount` takes a `code`. Two codes are recognised: `WELCOME10`
takes ten percent off, `HALFOFF` takes fifty. An unrecognised code is rejected
and leaves the cart untouched.

A recognised code must actually reduce the total the shopper is quoted. Recording
the discount without applying it is the failure this requirement exists to
prevent — a customer who is promised ten percent and charged full price has been
overcharged, whatever the cart record says.

## Placing the order

`POST /carts/:id/checkout` closes the cart and marks it placed. The total on the
placed order is the discounted total.

An empty cart cannot be checked out. There is nothing to fulfil and nothing to
charge for, so the request is rejected and the cart stays open.

## Reading a cart back

`GET /carts/:id` returns the cart with its current items, its discount, its
status, and the total a shopper would pay right now. An unknown cart id is a
not-found.
