import http, { type IncomingMessage } from 'node:http'

// Catalog service for the demo storefront. Three defects are planted here on
// purpose. They are what the `demo_catalog` feature catches, and what the
// repair loop is meant to fix.
//
// Two of them fail on the first run. The third cannot fail until the second is
// fixed — removing a product is what breaks the assumption its id scheme rests
// on — so repairing this service genuinely takes more than one pass. That is
// the point of the demo: a repair loop, not a single edit.

interface Product {
  id: string
  name: string
  price: number
}

const products: Product[] = []

// Ids are handed out from the catalog's current size, which stays unique for as
// long as the catalog only ever grows.
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
      // PLANTED DEFECT 1: a repriced product silently keeps its old price.
      // `name` is applied but `price` is never read off the patch, so the
      // request succeeds and the response looks right to a careless caller.
      if (patch.name !== undefined) product.name = patch.name
      res.end(JSON.stringify(product))
      return
    }

    if (method === 'DELETE' && url.pathname.startsWith('/products/')) {
      // PLANTED DEFECT 2: removing a product is not implemented at all, so a
      // discontinued item can never leave the catalog.
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
