import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
import { InventoryApi } from './helpers/api'

// The demo's known-good suite: every test here passes against the service as
// shipped. Keep it that way — this is what the Benchmark sabotages, and a
// benchmark whose baseline is already red can never score an agent.
//
// Deliberately UNANNOTATED: no @req-/@path- tags. That is the state every real
// codebase starts in, and it is what the Coverage tab's "distil requirements,
// then map them" flow is for. `demo_catalog` shows the annotated end state.

const api = new InventoryApi()

test.describe('demo_inventory', () => {
  test('lists every sku with its available count', async () => {
    const { status, body } = await api.list()
    expect(status).toBe(200)
    expect(body?.length ?? 0).toBeGreaterThan(0)
    for (const item of body ?? []) {
      expect(item.available).toBe(item.onHand - item.reserved)
    }
  })

  test('reads a single sku', async () => {
    const { status, body } = await api.get('espresso-beans')
    expect(status).toBe(200)
    expect(body?.sku).toBe('espresso-beans')
  })

  test('answers not-found for a sku that does not exist', async () => {
    const { status } = await api.get('no-such-sku')
    expect(status).toBe(404)
  })

  test('reserving stock reduces what is available', async () => {
    const before = await api.get('filter-papers')
    const { status, body } = await api.reserve('filter-papers', 3)
    expect(status).toBe(200)
    expect(body?.available).toBe((before.body?.available ?? 0) - 3)
  })

  test('refuses to reserve more than is available', async () => {
    const { body: item } = await api.get('espresso-beans')
    const { status } = await api.reserve('espresso-beans', (item?.available ?? 0) + 1)
    expect(status).toBe(409)
  })

  test('rejects a reservation quantity that is not a positive whole number', async () => {
    expect((await api.reserve('espresso-beans', 0)).status).toBe(400)
    expect((await api.reserve('espresso-beans', -2)).status).toBe(400)
  })
})
