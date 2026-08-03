import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
import { CatalogApi } from './helpers/api'

// Three of these tests fail against the shipped catalog service, and every
// failure is a real defect in the app — not a mistake in the test. Fixing them
// means editing demo-app/catalog-service/server.ts. Making the tests agree with
// the broken behaviour instead would hide exactly what this tool exists to find.
//
// The last one fails twice for different reasons: first because removal is not
// implemented, and then — once it is — because the id scheme assumed nothing
// ever leaves the catalog. That second failure is invisible until the first is
// fixed, which is why repairing this service takes more than one pass.

const api = new CatalogApi()

test.describe('demo_catalog', () => {
  test('a new product is added to the catalog', { tag: ['@req-R1', '@path-happy'] }, async () => {
    const product = await api.create('Espresso beans', 1800)
    expect(product?.id).toBeTruthy()
    expect(product?.name).toBe('Espresso beans')
    expect(product?.price).toBe(1800)
  })

  test('a product with no name is rejected', { tag: ['@req-R1', '@path-sad'] }, async () => {
    const res = await fetch(`${api.baseUrl}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price: 500 }),
    })
    expect(res.status).toBe(400)
  })

  test('the catalog lists every product that was added', { tag: ['@req-R2', '@path-happy'] }, async () => {
    const product = await api.create('Oat milk', 400)
    const products = await api.list()
    expect(products?.find((entry) => entry.id === product!.id)?.name).toBe('Oat milk')
  })

  test('repricing a product changes what it costs', { tag: ['@req-R3', '@path-happy'] }, async () => {
    const product = await api.create('Filter papers', 600)
    const updated = await api.reprice(product!.id, 450)
    expect(updated?.price).toBe(450)
  })

  test('a discontinued product leaves the catalog', { tag: ['@req-R4', '@path-happy'] }, async () => {
    const product = await api.create('Seasonal blend', 2200)
    await api.remove(product!.id)
    const products = await api.list()
    expect(products?.find((entry) => entry.id === product!.id)).toBeUndefined()
  })

  test('every product still has its own id after a removal', { tag: ['@req-R1', '@path-happy'] }, async () => {
    const drop = await api.create('House blend', 900)
    const keep = await api.create('Single origin', 1500)
    await api.remove(drop!.id)
    // Adding straight after a removal is the moment an id scheme that counts
    // the catalog, rather than the ids it has handed out, reissues one that is
    // already in use.
    await api.create('Decaf', 700)

    const products = await api.list()
    const ids = products!.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(products?.find((entry) => entry.id === keep!.id)?.name).toBe('Single origin')
  })
})
