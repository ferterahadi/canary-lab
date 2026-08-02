export interface StockItem {
  sku: string
  onHand: number
  reserved: number
  available: number
}

const jsonRequest = async <T>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T | null }> => {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const body = res.status === 204 ? null : ((await res.json()) as T)
  return { status: res.status, body }
}

export class InventoryApi {
  // Prefer the per-run port Canary Lab allocated for the local service
  // (CANARY_PORT_api); fall back to GATEWAY_URL, then a fixed default for
  // standalone use.
  baseUrl = process.env.CANARY_PORT_api
    ? `http://localhost:${process.env.CANARY_PORT_api}`
    : (process.env.GATEWAY_URL ?? 'http://localhost:4400')

  /** Read by the specs from the envset — an example of test configuration
   *  travelling with the environment rather than being hardcoded. */
  lowStockThreshold = Number.parseInt(process.env.LOW_STOCK_THRESHOLD ?? '5', 10)

  list = () => jsonRequest<StockItem[]>(`${this.baseUrl}/stock`)

  get = (sku: string) => jsonRequest<StockItem>(`${this.baseUrl}/stock/${sku}`)

  reserve = (sku: string, quantity: number) =>
    jsonRequest<StockItem>(`${this.baseUrl}/stock/${sku}/reserve`, {
      method: 'POST',
      body: JSON.stringify({ quantity }),
    })
}
