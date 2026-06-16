import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'

// Demonstrates the Verified Coverage rigor (strictness) dimension. These tests
// make their checks directly in the body (not via the helper) so the assertion-
// tier classifier can read which stack layer they touch:
//   • hitting the app's own API and asserting on its response = tier 3
//     ("the system reports success") — the honest ceiling for an API-only test.
//   • the PRD says deletion should ultimately be confirmed from the user-facing
//     surface (a browser) = tier 4 — which these tests do NOT reach.
// So after a passing run requirement R3 shows up as "shallow-verified": real
// passing evidence, but a stronger check (a browser confirming the list UI)
// exists and is unused.

const baseUrl = process.env.CANARY_PORT_api
  ? `http://localhost:${process.env.CANARY_PORT_api}`
  : (process.env.GATEWAY_URL ?? 'http://localhost:4000')

test.describe('example_todo_api coverage rigor demo', () => {
  // @requirement R1
  // @path happy
  test('create is confirmed by an independent read (tier 3)', async () => {
    await fetch(`${baseUrl}/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Rigor demo item' }),
    })
    const res = await fetch(`${baseUrl}/todos`)
    const todos = (await res.json()) as Array<{ title: string }>
    expect(todos.some((t) => t.title === 'Rigor demo item')).toBe(true)
  })

  // @requirement R3
  // @path happy
  test('delete is confirmed via the app API (tier 3, not the UI)', async () => {
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
