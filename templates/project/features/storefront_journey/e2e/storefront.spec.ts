import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
import { StorefrontApi } from './helpers/api'

// Seven journeys. J0 and J6 are sound and pass from the very first run — a
// suite where everything is broken cannot show that the harness reports what it
// finds rather than repairing whatever it touches. The other five are ORDERED
// chains of two contracts each. The second assertion in
// a journey is unreachable until the first passes, and the run stops at the
// first failing journey — so a repair agent only ever sees one broken contract
// at a time, and each repair reveals the next.
//
// What actually caps failures is `healOnFailureThreshold: 1` in
// feature.config.cjs: it becomes `--max-failures=1` on the command line, which
// OVERRIDES `maxFailures` in playwright.config.ts. Changing it here alone does
// nothing.
//
// Declaration order is the execution order (`workers: 1`). Keep it, and keep
// each journey's assertions ordered: a failed upstream contract must never be
// rounded into proof of a downstream one. Keep contracts stateless too — these
// services keep data in memory and are NOT restarted between heal cycles, so a
// contract that leaves residue behind drifts on every rerun.
//
// The `@req-*` tags map each contract to a requirement in
// `docs/_prd-summary.json`, which is what makes the coverage ledger read 100%
// on a fresh scaffold. `@path-*` says which side of the requirement the journey
// exercises. Adding a contract means adding its requirement too — otherwise the
// ledger reports an orphan test, not a bigger suite.

const api = new StorefrontApi()

test('J0 — the catalog serves the products it was given', { tag: ['@req-R1', '@path-happy'] }, async () => {
  // Sound on purpose: this journey passes on the first run and every run after.
  const created = await api.createProduct('Chemex Filters', 900)
  expect(created.status).toBe(201)
  expect(created.body?.priceCents).toBe(900)

  const listed = await api.listProducts()
  expect(listed.status).toBe(200)
  expect(listed.body?.some((p) => p.id === created.body!.id)).toBe(true)
})

test('J1 — a customer buys two in-stock catalog items with a welcome discount', { tag: ['@req-R2', '@req-R3', '@path-happy'] }, async () => {
  const product = await api.createProduct('Espresso Beans', 1800)
  expect(product.status).toBe(201)
  // Contract 1 — catalog: the SKU is the identity inventory consumes.
  expect(product.body?.sku).toBe('espresso-beans')

  const before = await api.getStock(product.body!.sku)
  const reservation = await api.reserve(product.body!.sku, 2)
  expect(before.status).toBe(200)
  expect(reservation.status).toBe(200)
  // Contract 2 — inventory: reserving consumes stock.
  expect(reservation.body?.available).toBe((before.body?.available ?? 0) - 2)
})

test('J2 — discount codes replace each other and change what the customer pays', { tag: ['@req-R4', '@req-R5', '@path-happy'] }, async () => {
  const product = await api.createProduct('Cold Brew Kit', 1800)
  const cart = await api.createCart()
  await api.addItem(cart.body!.id, product.body!, 2)

  const welcome = await api.discount(cart.body!.id, 'WELCOME10')
  expect(welcome.status).toBe(200)
  // Contract 1 — checkout: the recorded discount reaches the total.
  expect(welcome.body?.total).toBe(3240)

  const halfOff = await api.discount(cart.body!.id, 'HALFOFF')
  expect(halfOff.status).toBe(200)
  // Contract 2 — checkout: a second code REPLACES the first; they never stack.
  expect(halfOff.body?.total).toBe(1800)
})

test('J3 — reservations are refused honestly', { tag: ['@req-R6', '@req-R7', '@path-sad'] }, async () => {
  const held = await api.reserve('filter-papers', 2)
  expect(held.status).toBe(200)
  const remaining = held.body!.available

  const oversell = await api.reserve('filter-papers', 10_000)
  expect(oversell.status).toBe(409)
  // Contract 1 — inventory: the refusal reports what is actually still available.
  expect(oversell.body?.available).toBe(remaining)

  const unknown = await api.reserve('no-such-sku', 1)
  // Contract 2 — inventory: you cannot reserve stock for a product that does
  // not exist, and that is a missing resource, not a malformed request.
  expect(unknown.status).toBe(404)
})

test('J4 — a repriced product is charged at its new price', { tag: ['@req-R8', '@req-R9', '@path-happy'] }, async () => {
  const product = await api.createProduct('Pour Over Set', 1800)
  const repriced = await api.patchProduct(product.body!.id, { priceCents: 2000 })
  expect(repriced.status).toBe(200)
  // Contract 1 — catalog: a price change is persisted and returned.
  expect(repriced.body?.priceCents).toBe(2000)

  const cart = await api.createCart()
  await api.addItem(cart.body!.id, repriced.body!, 2)
  await api.discount(cart.body!.id, 'WELCOME10')
  const read = await api.getCart(cart.body!.id)
  expect(read.status).toBe(200)
  // Contract 2 — checkout: reading a cart shows the total checkout will charge.
  expect(read.body?.total).toBe(3600)
})

test('J5 — removing a product and refusing a bad code leave no debris', { tag: ['@req-R10', '@req-R11', '@path-happy', '@path-sad'] }, async () => {
  const doomed = await api.createProduct('Discontinued Grinder', 4500)
  const removed = await api.deleteProduct(doomed.body!.id)
  expect(removed.status).toBe(204)

  const listed = await api.listProducts()
  expect(listed.status).toBe(200)
  // Contract 1 — catalog: a deleted product is gone from the listing.
  expect(listed.body?.some((p) => p.id === doomed.body!.id)).toBe(false)

  const cart = await api.createCart()
  const staple = await api.createProduct('House Blend', 1000)
  await api.addItem(cart.body!.id, staple.body!, 2)
  await api.discount(cart.body!.id, 'WELCOME10')

  const rejected = await api.discount(cart.body!.id, 'NOT-A-CODE')
  expect(rejected.status).toBe(400)

  const read = await api.getCart(cart.body!.id)
  // Contract 2 — checkout: a refused code leaves the live discount intact.
  expect(read.body?.total).toBe(1800)
})

test('J6 — an empty cart cannot be placed', { tag: ['@req-R12', '@path-sad'] }, async () => {
  // Also sound on purpose. Guards a real rule: checkout refuses an empty cart
  // with 409 and leaves it open.
  const cart = await api.createCart()
  expect(cart.status).toBe(201)

  const placed = await api.checkout(cart.body!.id)
  expect(placed.status).toBe(409)

  const read = await api.getCart(cart.body!.id)
  expect(read.body?.status).toBe('open')
})
