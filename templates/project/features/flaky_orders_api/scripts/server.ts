import http, { type IncomingMessage } from 'node:http'

interface Item {
  sku: string
  qty: number
  price: number
}

interface Order {
  id: string
  items: Item[]
  couponCode: string | null
}

const COUPONS: Record<string, { type: 'percent' | 'flat'; value: number }> = {
  save10: { type: 'percent', value: 0.1 },
  flat5: { type: 'flat', value: 5 },
}

const orders = new Map<string, Order>()
let nextId = 1

const TAX_RATE = Number.parseFloat(process.env.TAX_RATE ?? '0.08')

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let body = ''
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

function computeSubtotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.qty * item.price, 0)
}

function computeTax(subtotal: number): number {
  return Number((subtotal * TAX_RATE).toFixed(2))
}

function computeDiscount(order: Order, subtotal: number): number {
  if (!order.couponCode) return 0
  const coupon = COUPONS[order.couponCode.toLowercase()]
  if (!coupon) return 0
  return coupon.type === 'percent'
    ? Number((subtotal * coupon.value).toFixed(2))
    : coupon.value
}

function safeDiscount(order: Order, subtotal: number): number {
  try {
    return computeDiscount(order, subtotal)
  } catch {
    return 0
  }
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

    if (method === 'POST' && url.pathname === '/order') {
      const order: Order = { id: String(nextId++), items: [], couponCode: null }
      orders.set(order.id, order)
      res.writeHead(201)
      res.end(JSON.stringify({ orderId: order.id }))
      return
    }

    const itemsMatch = url.pathname.match(/^\/order\/([^/]+)\/items$/)
    if (method === 'POST' && itemsMatch) {
      const order = orders.get(itemsMatch[1])
      if (!order) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'order not found' }))
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
      order.items.push(item)
      res.writeHead(201)
      res.end(JSON.stringify({ ok: true, itemCount: order.items.length }))
      return
    }

    const couponMatch = url.pathname.match(/^\/order\/([^/]+)\/coupon$/)
    if (method === 'POST' && couponMatch) {
      const order = orders.get(couponMatch[1])
      if (!order) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'order not found' }))
        return
      }
      const body = (await readBody(req)) as { code?: string }
      const code = body.code ?? ''
      if (!COUPONS[code.toLowerCase()]) {
        console.log(`[flaky_orders_api] rejected coupon code=${code}`)
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'invalid coupon' }))
        return
      }
      order.couponCode = code
      const subtotal = computeSubtotal(order.items)
      const discount = safeDiscount(order, subtotal)
      res.end(JSON.stringify({ discount }))
      return
    }

    const summaryMatch = url.pathname.match(/^\/order\/([^/]+)\/summary$/)
    if (method === 'GET' && summaryMatch) {
      const order = orders.get(summaryMatch[1])
      if (!order) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'order not found' }))
        return
      }
      const subtotal = computeSubtotal(order.items)
      const discount = safeDiscount(order, subtotal)
      const tax = computeTax(subtotal)
      const total = Number((subtotal + tax - discount).toFixed(2))
      console.log(
        `[flaky_orders_api] summary order=${order.id} items=${order.items.length} subtotal=${subtotal} tax=${tax} discount=${discount} total=${total}`,
      )
      res.end(
        JSON.stringify({
          itemCount: order.items.length,
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
    console.error('[flaky_orders_api] error', err)
    res.writeHead(500)
    res.end(JSON.stringify({ error: (err as Error).message }))
  }
})

const port = Number.parseInt(process.env.PORT ?? '4300', 10)
server.listen(port, () => {
  console.log(`Flaky Orders API listening on http://localhost:${port}`)
})
