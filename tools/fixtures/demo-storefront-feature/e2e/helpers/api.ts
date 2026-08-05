export interface Product {
  id: string
  name: string
  sku: string
  priceCents: number
}

export interface StockItem {
  sku: string
  onHand: number
  reserved: number
  available: number
}

export interface Cart {
  id: string
  discountPercent: number
  status: 'open' | 'placed'
  total: number
}

const request = async <T>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T | null }> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json() as T,
  }
}

export class StorefrontApi {
  private readonly catalog = `http://localhost:${process.env.CANARY_PORT_catalog ?? '4200'}`
  private readonly inventory = `http://localhost:${process.env.CANARY_PORT_inventory ?? '4400'}`
  private readonly checkoutBase = process.env.CHECKOUT_URL ?? 'http://localhost:4300'

  createProduct = (name: string, priceCents: number) => request<Product>(`${this.catalog}/products`, {
    method: 'POST',
    body: JSON.stringify({ name, priceCents }),
  })

  getStock = (sku: string) => request<StockItem>(`${this.inventory}/stock/${sku}`)

  reserve = (sku: string, quantity: number) => request<StockItem>(`${this.inventory}/stock/${sku}/reserve`, {
    method: 'POST',
    body: JSON.stringify({ quantity }),
  })

  createCart = () => request<Cart>(`${this.checkoutBase}/carts`, { method: 'POST' })

  addItem = (cartId: string, product: Product, quantity: number) => request<Cart>(`${this.checkoutBase}/carts/${cartId}/items`, {
    method: 'POST',
    body: JSON.stringify({ sku: product.sku, unitPrice: product.priceCents, quantity }),
  })

  discount = (cartId: string, code: string) => request<Cart>(`${this.checkoutBase}/carts/${cartId}/discount`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  })

  checkout = (cartId: string) => request<Cart>(`${this.checkoutBase}/carts/${cartId}/checkout`, {
    method: 'POST',
  })
}
