export interface Product {
  id: string
  name: string
  price: number
}

const jsonRequest = async <T>(url: string, init: RequestInit = {}): Promise<T | null> => {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${res.status}`)
  }
  return res.status === 204 ? null : ((await res.json()) as T)
}

export class CatalogApi {
  // Prefer the per-run port Canary Lab allocated for the local service
  // (CANARY_PORT_api); fall back to GATEWAY_URL for remote/production runs,
  // then a fixed default for standalone use.
  baseUrl = process.env.CANARY_PORT_api
    ? `http://localhost:${process.env.CANARY_PORT_api}`
    : (process.env.GATEWAY_URL ?? 'http://localhost:4200')

  create = (name: string, price: number) =>
    jsonRequest<Product>(`${this.baseUrl}/products`, {
      method: 'POST',
      body: JSON.stringify({ name, price }),
    })

  list = () => jsonRequest<Product[]>(`${this.baseUrl}/products`)

  reprice = (id: string, price: number) =>
    jsonRequest<Product>(`${this.baseUrl}/products/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ price }),
    })

  remove = (id: string) =>
    jsonRequest<null>(`${this.baseUrl}/products/${id}`, { method: 'DELETE' })
}
