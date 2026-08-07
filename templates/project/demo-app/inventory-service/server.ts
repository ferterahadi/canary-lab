import http, { type IncomingMessage } from 'node:http'

// Second service in the storefront journey. It consumes the SKU produced by
// catalog and turns a reservation into the stock evidence checkout relies on.

interface StockItem {
  sku: string
  onHand: number
  reserved: number
}

const stock = new Map<string, StockItem>([
  ['espresso-beans', { sku: 'espresso-beans', onHand: 40, reserved: 0 }],
  ['filter-papers', { sku: 'filter-papers', onHand: 120, reserved: 0 }],
])

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let body = ''
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

const available = (item: StockItem): number => item.onHand + item.reserved

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const segments = url.pathname.split('/').filter(Boolean)
  res.setHeader('Content-Type', 'application/json')
  console.log(`[inventory-service] ${req.method} ${url.pathname}`)

  // GET / — readiness probe.
  if (req.method === 'GET' && segments.length === 0) {
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true, service: 'inventory' }))
    return
  }

  // GET /stock — every sku with its available count.
  if (req.method === 'GET' && segments[0] === 'stock' && segments.length === 1) {
    res.writeHead(200)
    res.end(JSON.stringify([...stock.values()].map((i) => ({ ...i, available: available(i) }))))
    return
  }

  // GET /stock/:sku — one sku, 404 when unknown.
  if (req.method === 'GET' && segments[0] === 'stock' && segments.length === 2) {
    const item = stock.get(segments[1])
    if (!item) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'unknown sku' }))
      return
    }
    res.writeHead(200)
    res.end(JSON.stringify({ ...item, available: available(item) }))
    return
  }

  // POST /stock/:sku/reserve — reserve N units, refusing to oversell.
  if (req.method === 'POST' && segments[0] === 'stock' && segments[2] === 'reserve') {
    const item = stock.get(segments[1])
    if (!item) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'unknown sku' }))
      return
    }
    const { quantity } = (await readBody(req)) as { quantity?: number }
    const wanted = Number(quantity ?? 0)
    if (!Number.isInteger(wanted) || wanted <= 0) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'quantity must be a positive whole number' }))
      return
    }
    if (wanted > available(item)) {
      res.writeHead(409)
      res.end(JSON.stringify({ error: 'not enough stock', available: item.onHand }))
      return
    }
    item.reserved += wanted
    res.writeHead(200)
    res.end(JSON.stringify({ ...item, available: available(item) }))
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'not found' }))
})

const port = Number.parseInt(process.env.PORT ?? '4400', 10)
server.listen(port, () => {
  console.log(`Inventory service listening on http://localhost:${port}`)
})
