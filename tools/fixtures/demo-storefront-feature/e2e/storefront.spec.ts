import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
import { StorefrontApi } from './helpers/api'

const api = new StorefrontApi()

test('a customer buys two in-stock catalog items with a welcome discount', async () => {
  const product = await api.createProduct('Espresso Beans', 1800)
  expect(product.status).toBe(201)
  expect(product.body?.sku).toBe('espresso-beans')

  const before = await api.getStock(product.body!.sku)
  const reservation = await api.reserve(product.body!.sku, 2)
  expect(before.status).toBe(200)
  expect(reservation.status).toBe(200)
  expect(reservation.body?.available).toBe((before.body?.available ?? 0) - 2)

  const cart = await api.createCart()
  await api.addItem(cart.body!.id, product.body!, 2)
  await api.discount(cart.body!.id, 'WELCOME10')
  const order = await api.checkout(cart.body!.id)
  expect(order.status).toBe(200)
  expect(order.body?.status).toBe('placed')
  expect(order.body?.total).toBe(3240)
})
