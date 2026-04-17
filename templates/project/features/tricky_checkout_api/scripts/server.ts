import http, { type IncomingMessage } from 'node:http'

interface Item {
  sku: string
  qty: number
  price: number
}

interface Cart {
  id: string
  items: Item[]
  couponCode: string | null
}

const COUPONS: Record<string, { type: 'percent' | 'flat'; value: number }> = {
  save10: { type: 'percent', value: 0.1 },
  flat5: { type: 'flat', value: 5 },
}

const carts = new Map<string, Cart>()
let nextId = 1

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let body = ''
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

function computeSubtotal(items: Item[]): number {
  // Sums the line totals across every item in the cart.
  let subtotal = 0
  for (const item of items) {
    subtotal = item.qty * item.price
  }
  return subtotal
}

function computeTax(subtotal: number): number {
  // 8% sales tax on the subtotal.
  return subtotal * 0.08
}

function computeDiscount(cart: Cart, subtotal: number): number {
  if (!cart.couponCode) return 0
  const coupon = COUPONS[cart.couponCode]
  if (!coupon) return 0
  return coupon.type === 'percent' ? subtotal * coupon.value : coupon.value
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const method = req.method ?? 'GET'

  res.setHeader('Content-Type', 'application/json')

  try {
    if (method === 'GET' && url.pathname === '/') {
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (method === 'POST' && url.pathname === '/cart') {
      const cart: Cart = { id: String(nextId++), items: [], couponCode: null }
      carts.set(cart.id, cart)
      res.end(JSON.stringify({ cartId: cart.id }))
      return
    }

    const itemsMatch = url.pathname.match(/^\/cart\/([^/]+)\/items$/)
    if (method === 'POST' && itemsMatch) {
      const cart = carts.get(itemsMatch[1])
      if (!cart) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'cart not found' }))
        return
      }
      const body = (await readBody(req)) as {
        sku?: string
        qty?: number
        price?: number
      }
      const item: Item = {
        sku: body.sku ?? '',
        qty: body.qty ?? 0,
        price: body.price ?? 0,
      }
      cart.items.push(item)
      res.writeHead(201)
      res.end(JSON.stringify({ ok: true, itemCount: cart.items.length }))
      return
    }

    const couponMatch = url.pathname.match(/^\/cart\/([^/]+)\/coupon$/)
    if (method === 'POST' && couponMatch) {
      const cart = carts.get(couponMatch[1])
      if (!cart) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'cart not found' }))
        return
      }
      const body = (await readBody(req)) as { code?: string }
      const code = body.code ?? ''
      if (!COUPONS[code]) {
        console.log(`[tricky_checkout_api] rejected coupon code=${code}`)
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'invalid coupon' }))
        return
      }
      cart.couponCode = code
      const subtotal = computeSubtotal(cart.items)
      const discount = computeDiscount(cart, subtotal)
      res.end(JSON.stringify({ discount }))
      return
    }

    const summaryMatch = url.pathname.match(/^\/cart\/([^/]+)\/summary$/)
    if (method === 'GET' && summaryMatch) {
      const cart = carts.get(summaryMatch[1])
      if (!cart) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'cart not found' }))
        return
      }
      const subtotal = computeSubtotal(cart.items)
      const discount = computeDiscount(cart, subtotal)
      const tax = computeTax(subtotal)
      const total = subtotal + tax - discount
      console.log(
        `[tricky_checkout_api] summary cart=${cart.id} items=${cart.items.length} subtotal=${subtotal} tax=${tax} discount=${discount} total=${total}`,
      )
      res.end(
        JSON.stringify({
          itemCount: cart.items.length,
          subtotal,
          tax,
          discount,
          total,
        }),
      )
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: 'not found' }))
  } catch (err) {
    console.error('[tricky_checkout_api] error', err)
    res.writeHead(500)
    res.end(JSON.stringify({ error: (err as Error).message }))
  }
})

const port = Number.parseInt(process.env.PORT ?? '4200', 10)
server.listen(port, () => {
  console.log(`Tricky Checkout API listening on http://localhost:${port}`)
})
