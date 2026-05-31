export interface Item {
  sku: string
  qty: number
  price: number
}

export interface Summary {
  itemCount: number
  subtotal: number
  tax: number
  discount: number
  total: number
}

interface Response<T> {
  status: number
  body: T | null
}

async function jsonCall<T>(url: string, init: RequestInit = {}): Promise<Response<T>> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const text = await res.text()
  const body = text ? (JSON.parse(text) as T) : null
  return { status: res.status, body }
}

export class CheckoutApi {
  // Prefer the per-run port Canary Lab allocated for the local service
  // (CANARY_PORT_api); fall back to GATEWAY_URL for remote runs.
  baseUrl = process.env.CANARY_PORT_api
    ? `http://localhost:${process.env.CANARY_PORT_api}`
    : (process.env.GATEWAY_URL ?? 'http://localhost:4200')

  createCart = () =>
    jsonCall<{ cartId: string }>(`${this.baseUrl}/cart`, { method: 'POST' })

  addItem = (cartId: string, item: Item) =>
    jsonCall<{ ok: true; itemCount: number }>(
      `${this.baseUrl}/cart/${cartId}/items`,
      {
        method: 'POST',
        body: JSON.stringify(item),
      },
    )

  applyCoupon = (cartId: string, code: string) =>
    jsonCall<{ discount: number } | { error: string }>(
      `${this.baseUrl}/cart/${cartId}/coupon`,
      {
        method: 'POST',
        body: JSON.stringify({ code }),
      },
    )

  summary = async (cartId: string): Promise<Summary | null> => {
    const { body } = await jsonCall<Summary>(`${this.baseUrl}/cart/${cartId}/summary`)
    return body
  }
}
