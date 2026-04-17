import { test, expect } from 'canary-lab/feature-support/log-marker-fixture'
import { CheckoutApi } from './helpers/api'

const api = new CheckoutApi()

test.describe('tricky_checkout_api', () => {
  test('POST /cart returns 201 with a cartId', async () => {
    const { status, body } = await api.createCart()
    expect(status).toBe(201)
    expect(body?.cartId).toBeTruthy()
  })

  test('multiple items accumulate into the subtotal', async () => {
    const { body: created } = await api.createCart()
    const cartId = created!.cartId
    await api.addItem(cartId, { sku: 'A', qty: 2, price: 10 })
    await api.addItem(cartId, { sku: 'B', qty: 1, price: 7.5 })
    const summary = await api.summary(cartId)
    expect(summary?.subtotal).toBe(27.5)
  })

  test('tax rounds to 2 decimal places', async () => {
    const { body: created } = await api.createCart()
    const cartId = created!.cartId
    await api.addItem(cartId, { sku: 'TAX', qty: 1, price: 1.1 })
    const summary = await api.summary(cartId)
    expect(summary?.tax).toBe(0.09)
  })

  test('coupon codes are case-insensitive', async () => {
    const { body: created } = await api.createCart()
    const cartId = created!.cartId
    await api.addItem(cartId, { sku: 'X', qty: 1, price: 100 })
    const { status } = await api.applyCoupon(cartId, 'SAVE10')
    expect(status).toBe(200)
  })
})
