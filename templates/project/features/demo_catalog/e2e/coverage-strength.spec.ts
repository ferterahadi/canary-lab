import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'

// Demonstrates per-test coverage STRENGTH (the depth dimension). These tests make
// their checks directly in the body (not via a helper) so the assertion-tier
// classifier can read which stack layer they touch:
//   • hitting the app's own API and asserting on its response = tier 3 → the test
//     grades as "Solid" (the system reports success).
//   • a check that only read a log would be tier 1 → "Shallow"; a real external
//     destination would be tier 4 → "Strong". This local API has none, so Solid
//     is the honest ceiling here.
// Strength is independent of test runs — it grades what the test WOULD prove.

const baseUrl = process.env.CANARY_PORT_api
  ? `http://localhost:${process.env.CANARY_PORT_api}`
  : (process.env.GATEWAY_URL ?? 'http://localhost:4200')

test.describe('demo_catalog coverage strength demo', () => {
  test('adding a product is confirmed by an independent read (tier 3 → Solid)', { tag: ['@req-R1', '@path-happy'] }, async () => {
    await fetch(`${baseUrl}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Rigor demo item', price: 100 }),
    })
    const res = await fetch(`${baseUrl}/products`)
    const products = (await res.json()) as Array<{ name: string }>
    expect(products.some((p) => p.name === 'Rigor demo item')).toBe(true)
  })

  test('the catalog read reports the stored price (tier 3 → Solid, not a browser)', { tag: ['@req-R2', '@path-happy'] }, async () => {
    const created = await fetch(`${baseUrl}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Priced item', price: 750 }),
    })
    const product = (await created.json()) as { id: string }
    const res = await fetch(`${baseUrl}/products`)
    const products = (await res.json()) as Array<{ id: string; price: number }>
    expect(products.find((p) => p.id === product.id)?.price).toBe(750)
  })
})
