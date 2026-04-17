import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
import { OrdersApi } from './helpers/api'

const api = new OrdersApi()

test.describe('flaky_orders_api', () => {
  test('POST /order returns 201 with an orderId', async () => {
    const { status, body } = await api.createOrder()
    expect(status).toBe(201)
    expect(body?.orderId).toBeTruthy()
  })

  test('summary applies 8% tax on the subtotal', async () => {
    const { body: created } = await api.createOrder()
    const orderId = created!.orderId
    await api.addItem(orderId, { sku: 'A', qty: 2, price: 10 })
    await api.addItem(orderId, { sku: 'B', qty: 1, price: 5 })
    const summary = await api.summary(orderId)
    expect(summary?.subtotal).toBe(25)
    expect(summary?.tax).toBe(2)
  })

  test('applying SAVE10 coupon produces a 10% discount on the summary', async () => {
    const { body: created } = await api.createOrder()
    const orderId = created!.orderId
    await api.addItem(orderId, { sku: 'X', qty: 1, price: 100 })
    const { status } = await api.applyCoupon(orderId, 'SAVE10')
    expect(status).toBe(200)
    const summary = await api.summary(orderId)
    expect(summary?.discount).toBe(10)
  })
})
