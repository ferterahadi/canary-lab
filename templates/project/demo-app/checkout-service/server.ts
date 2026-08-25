import http, { type IncomingMessage } from 'node:http'

// Final service in the storefront journey. It consumes catalog's price and the
// successful inventory reservation to produce the customer-facing total.

interface CartItem {
  sku: string
  unitPrice: number
  quantity: number
}

interface Cart {
  id: string
  items: CartItem[]
  discountPercent: number
  status: 'open' | 'placed'
}

const carts = new Map<string, Cart>()
let nextId = 1

const DISCOUNT_CODES: Record<string, number> = { WELCOME10: 10, HALFOFF: 50 }

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let body = ''
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

const subtotal = (cart: Cart): number =>
  cart.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)

const total = (cart: Cart): number => subtotal(cart)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const method = req.method ?? 'GET'
  const segments = url.pathname.split('/').filter(Boolean)

  console.log(`[checkout-service] ${method} ${url.pathname}`)
  res.setHeader('Content-Type', 'application/json')

  try {
    if (method === 'GET' && url.pathname === '/') {
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (method === 'POST' && url.pathname === '/carts') {
      const cart: Cart = { id: String(nextId++), items: [], discountPercent: 0, status: 'open' }
      carts.set(cart.id, cart)
      res.writeHead(201)
      res.end(JSON.stringify({ ...cart, total: 0 }))
      return
    }

    const cart = segments[0] === 'carts' ? carts.get(segments[1] ?? '') : undefined
    if (segments[0] === 'carts' && !cart) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'cart not found' }))
      return
    }

    if (method === 'GET' && cart && segments.length === 2) {
      res.end(JSON.stringify({ ...cart, total: subtotal(cart) }))
      return
    }

    if (method === 'POST' && cart && segments[2] === 'items') {
      const { sku, unitPrice, quantity } = (await readBody(req)) as Partial<CartItem>
      if (!sku || typeof unitPrice !== 'number') {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'sku and unitPrice are required' }))
        return
      }
      cart.items.push({ sku, unitPrice, quantity: quantity ?? 1 })
      res.writeHead(201)
      res.end(JSON.stringify({ ...cart, total: total(cart) }))
      return
    }

    if (method === 'POST' && cart && segments[2] === 'discount') {
      const { code } = (await readBody(req)) as { code?: string }
      const percent = DISCOUNT_CODES[(code ?? '').toUpperCase()]
      if (percent === undefined) {
        cart.discountPercent = 0
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'unknown discount code' }))
        return
      }
      cart.discountPercent += percent
      res.end(JSON.stringify({ ...cart, total: total(cart) }))
      return
    }

    if (method === 'POST' && cart && segments[2] === 'checkout') {
      if (cart.items.length === 0) {
        res.writeHead(409)
        res.end(JSON.stringify({ error: 'cart is empty' }))
        return
      }
      cart.status = 'placed'
      res.end(JSON.stringify({ ...cart, total: total(cart) }))
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
// of this service never clash. 4300 is only the standalone fallback.
const port = Number.parseInt(process.env.PORT ?? '4300', 10)
server.listen(port, () => {
  console.log(`Checkout service listening on http://localhost:${port}`)
})
