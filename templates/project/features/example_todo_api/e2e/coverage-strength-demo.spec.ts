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
  : (process.env.GATEWAY_URL ?? 'http://localhost:4000')

test.describe('example_todo_api coverage strength demo', () => {
  test('create is confirmed by an independent read (tier 3 → Solid)', { tag: ['@req-R1', '@path-happy'] }, async () => {
    await fetch(`${baseUrl}/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Rigor demo item' }),
    })
    const res = await fetch(`${baseUrl}/todos`)
    const todos = (await res.json()) as Array<{ title: string }>
    expect(todos.some((t) => t.title === 'Rigor demo item')).toBe(true)
  })

  test('delete is confirmed via the app API (tier 3 → Solid, not a browser)', { tag: ['@req-R3', '@path-happy'] }, async () => {
    const created = await fetch(`${baseUrl}/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'To be removed' }),
    })
    const todo = (await created.json()) as { id: string }
    const del = await fetch(`${baseUrl}/todos/${todo.id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    const res = await fetch(`${baseUrl}/todos`)
    const todos = (await res.json()) as Array<{ id: string }>
    expect(todos.find((t) => t.id === todo.id)).toBeUndefined()
  })
})
