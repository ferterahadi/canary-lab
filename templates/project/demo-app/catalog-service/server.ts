import http, { type IncomingMessage } from 'node:http'

// Catalog service for the demo storefront: an in-memory product catalog behind
// a small JSON API. The `demo_catalog` suite runs against it.

interface Product {
  id: string
  name: string
  price: number
}

const products: Product[] = []

const nextProductId = () => String(products.length + 1)

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
      const { name, price } = (await readBody(req)) as { name?: string; price?: number }
      if (!name) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'name is required' }))
        return
      }
      const product: Product = { id: nextProductId(), name, price: price ?? 0 }
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
      const patch = (await readBody(req)) as { name?: string; price?: number }
      if (patch.name !== undefined) product.name = patch.name
      res.end(JSON.stringify(product))
      return
    }

    if (method === 'DELETE' && url.pathname.startsWith('/products/')) {
      res.writeHead(405)
      res.end(JSON.stringify({ error: 'delete is not supported' }))
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
