import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
import { CatalogApi } from './helpers/api'

// Two of these tests fail against the shipped catalog service, and both failures
// are real defects in the app — not mistakes in the tests. Fixing them means
// editing demo-app/catalog-service/server.ts. Making the tests agree with the
// broken behaviour instead would hide exactly what this tool exists to find.

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
})
