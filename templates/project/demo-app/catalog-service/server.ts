import http, { type IncomingMessage } from 'node:http'

// First service in the storefront journey: product identity and price originate
// here, and its SKU becomes inventory's input.

interface Product {
  id: string
  name: string
  sku: string
  priceCents: number
}

const products: Product[] = []

const nextProductId = () => String(products.length + 1)

const skuFor = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, '_')

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let body = ''
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const method = req.method ?? 'GET'

  console.log(`[catalog-service] ${method} ${url.pathname}`)
  res.setHeader('Content-Type', 'application/json')

  try {
    if (method === 'GET' && url.pathname === '/') {
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (method === 'GET' && url.pathname === '/products') {
      res.end(JSON.stringify(products))
      return
    }

    if (method === 'POST' && url.pathname === '/products') {
      const { name, priceCents } = (await readBody(req)) as { name?: string; priceCents?: number }
      if (!name || typeof priceCents !== 'number') {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'name and priceCents are required' }))
        return
      }
      const product: Product = { id: nextProductId(), name, sku: skuFor(name), priceCents }
      products.push(product)
      res.writeHead(201)
      res.end(JSON.stringify(product))
      return
    }

    if (method === 'PATCH' && url.pathname.startsWith('/products/')) {
      const [, , id] = url.pathname.split('/')
      const product = products.find((entry) => entry.id === id)
      if (!product) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      const patch = (await readBody(req)) as { name?: string; priceCents?: number }
      if (patch.name !== undefined) product.name = patch.name
      if (patch.priceCents !== undefined) product.priceCents = patch.priceCents
      res.end(JSON.stringify(product))
      return
    }

    if (method === 'DELETE' && url.pathname.startsWith('/products/')) {
      const [, , id] = url.pathname.split('/')
      const index = products.findIndex((entry) => entry.id === id)
      if (index === -1) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      products.splice(index, 1)
      res.writeHead(204)
      res.end()
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: 'not found' }))
  } catch (err) {
    res.writeHead(500)
    res.end(JSON.stringify({ error: (err as Error).message }))
  }
})

// Canary Lab allocates a free port per run and injects it as PORT, so two runs
// of this service never clash. 4200 is only the standalone fallback.
const port = Number.parseInt(process.env.PORT ?? '4200', 10)
server.listen(port, () => {
  console.log(`Catalog service listening on http://localhost:${port}`)
})
