// The perturbation shim (D14): one HTTP proxy per declared port slot. Playwright
// and the envsets talk to the shim; the service keeps its real port. These tests
// run a real stub upstream on a loopback port — the shim's whole job is what it
// does to real sockets, so a mocked http module would prove nothing.
import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'http'
import net from 'net'
import { startProxyShim, type ProxyShim } from './proxy-shim'

interface SeenRequest { method: string; url: string; headers: http.IncomingHttpHeaders; body: string; at: number }

interface StubUpstream { port: number; seen: SeenRequest[]; close: () => Promise<void> }

async function stubUpstream(handler?: (req: SeenRequest, res: http.ServerResponse) => void): Promise<StubUpstream> {
  const seen: SeenRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const r: SeenRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), at: Date.now() }
      seen.push(r)
      if (handler) return handler(r, res)
      res.setHeader('x-upstream', 'yes')
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ echo: r.body, n: seen.length }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as net.AddressInfo
  return { port: addr.port, seen, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

async function send(port: number, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; elapsedMs: number }> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), elapsedMs: Date.now() - started }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await sleep(10)
  }
}

const open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  while (open.length) await open.pop()!.close()
})

async function shimFor(upstream: StubUpstream, opts: Partial<Parameters<typeof startProxyShim>[0]> = {}): Promise<ProxyShim> {
  const shim = await startProxyShim({ slot: 'api', upstreamPort: upstream.port, listenPort: 0, ...opts })
  open.push(shim)
  return shim
}

describe('startProxyShim — forwarding', () => {
  it('forwards method, path + query, headers and body, and returns the upstream status, headers and body', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    const shim = await shimFor(upstream)
    expect(shim.slot).toBe('api')
    expect(shim.upstreamPort).toBe(upstream.port)
    expect(shim.port).toBeGreaterThan(0)

    const res = await send(shim.port, 'POST', '/reserve?sku=7', '{"qty":1}', { 'content-type': 'application/json', 'idempotency-key': 'k1' })

    expect(res.status).toBe(201)
    expect(res.headers['x-upstream']).toBe('yes')
    expect(JSON.parse(res.body)).toEqual({ echo: '{"qty":1}', n: 1 })
    expect(upstream.seen).toHaveLength(1)
    expect(upstream.seen[0]).toMatchObject({ method: 'POST', url: '/reserve?sku=7', body: '{"qty":1}' })
    expect(upstream.seen[0].headers['idempotency-key']).toBe('k1')
    expect(upstream.seen[0].headers['content-type']).toBe('application/json')
    expect(shim.events).toEqual([{ at: expect.any(String), kind: 'forwarded', slot: 'api', method: 'POST', path: '/reserve?sku=7' }])
  })

  it('answers 502 with the reason when the upstream is unreachable, instead of hanging the test', async () => {
    const upstream = await stubUpstream()
    await upstream.close()
    const shim = await shimFor(upstream)

    const res = await send(shim.port, 'GET', '/health')

    expect(res.status).toBe(502)
    expect(res.body).toMatch(/upstream 127\.0\.0\.1:\d+ .*ECONNREFUSED/)
    expect(shim.events).toEqual([{ at: expect.any(String), kind: 'upstream-error', slot: 'api', method: 'GET', path: '/health', reason: expect.stringContaining('ECONNREFUSED') }])
  })

  // v1 is HTTP/1.1 only. A WebSocket upgrade is refused, never silently
  // perturbed, and the refusal is on the record for the finding.
  it('refuses a WebSocket upgrade and logs it', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    const shim = await shimFor(upstream)

    const closed = new Promise<void>((resolve) => {
      const sock = net.connect(shim.port, '127.0.0.1', () => {
        sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
      })
      sock.resume()
      sock.on('close', () => resolve())
      sock.on('error', () => resolve())
    })
    await closed

    expect(shim.events).toEqual([{ at: expect.any(String), kind: 'upgrade-refused', slot: 'api', method: 'GET', path: '/ws' }])
    expect(upstream.seen).toHaveLength(0)
  })

  it('rejects when the listen port is already taken', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    const taken = await shimFor(upstream)
    await expect(startProxyShim({ slot: 'api', upstreamPort: upstream.port, listenPort: taken.port })).rejects.toThrow(/EADDRINUSE/)
  })

  it('aborts an in-flight upstream request on close instead of leaving the client hanging', async () => {
    const upstream = await stubUpstream(() => { /* never answers */ }); open.push(upstream)
    const shim = await startProxyShim({ slot: 'api', upstreamPort: upstream.port, listenPort: 0 })

    const pending = send(shim.port, 'GET', '/slow')
    await waitFor(() => upstream.seen.length === 1)
    await shim.close()

    await expect(pending).rejects.toThrow(/socket hang up|ECONNRESET/)
  })

  it('stops listening on close', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    const shim = await startProxyShim({ slot: 'api', upstreamPort: upstream.port, listenPort: 0 })
    await shim.close()
    await expect(send(shim.port, 'GET', '/')).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe('startProxyShim — latency atom', () => {
  it('delays every response by the fixed ms and records the delay', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    const shim = await shimFor(upstream, { latency: { ms: 150 } })

    const res = await send(shim.port, 'GET', '/items')

    expect(res.status).toBe(201)
    expect(res.elapsedMs).toBeGreaterThanOrEqual(140)
    expect(shim.events).toEqual([{ at: expect.any(String), kind: 'forwarded', slot: 'api', method: 'GET', path: '/items', delayedMs: 150 }])
  })
})

describe('startProxyShim — duplicate atom', () => {
  it('replays a matching request once after gapMs with the same body and headers, and answers the client once', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    const shim = await shimFor(upstream, { duplicate: { gapMs: 100, match: 'POST /reserve' } })

    const res = await send(shim.port, 'POST', '/reserve', '{"sku":7}', { 'content-type': 'application/json', 'idempotency-key': 'k1' })
    expect(JSON.parse(res.body)).toEqual({ echo: '{"sku":7}', n: 1 })

    await waitFor(() => upstream.seen.length === 2)
    expect(upstream.seen[1]).toMatchObject({ method: 'POST', url: '/reserve', body: '{"sku":7}' })
    expect(upstream.seen[1].headers['idempotency-key']).toBe('k1')
    expect(upstream.seen[1].headers['content-type']).toBe('application/json')
    expect(upstream.seen[1].at - upstream.seen[0].at).toBeGreaterThanOrEqual(90)
    // exactly once: the replay is never itself replayed
    await sleep(250)
    expect(upstream.seen).toHaveLength(2)
    expect(shim.events).toEqual([
      { at: expect.any(String), kind: 'forwarded', slot: 'api', method: 'POST', path: '/reserve' },
      { at: expect.any(String), kind: 'duplicated', slot: 'api', method: 'POST', path: '/reserve', gapMs: 100 },
    ])
  })

  it('leaves a non-matching request alone', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    const shim = await shimFor(upstream, { duplicate: { gapMs: 50, match: 'WRITE /**' } })

    await send(shim.port, 'GET', '/reserve')
    await sleep(150)

    expect(upstream.seen).toHaveLength(1)
    expect(shim.events.map((e) => e.kind)).toEqual(['forwarded'])
  })

  it('cancels a scheduled replay when the shim closes first', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    const shim = await startProxyShim({ slot: 'api', upstreamPort: upstream.port, listenPort: 0, duplicate: { gapMs: 200, match: 'POST /x' } })

    await send(shim.port, 'POST', '/x', 'b')
    await shim.close()
    await sleep(300)

    expect(upstream.seen).toHaveLength(1)
  })

  // Best-effort by design: the replay exists to provoke the app, and the
  // client already has its answer. A dead upstream at replay time is recorded,
  // never raised.
  it('records a replay that could not reach the upstream', async () => {
    const upstream = await stubUpstream()
    const shim = await shimFor(upstream, { duplicate: { gapMs: 50, match: 'POST /x' } })

    await send(shim.port, 'POST', '/x', 'b')
    await upstream.close()
    await waitFor(() => shim.events.some((e) => e.kind === 'duplicate-error'))

    expect(shim.events[2]).toEqual({ at: expect.any(String), kind: 'duplicate-error', slot: 'api', method: 'POST', path: '/x', reason: expect.stringContaining('ECONNREFUSED') })
  })
})

describe('startProxyShim — restart atom', () => {
  it('holds the Nth matching request until the restart completes, then forwards it; other matches pass untouched', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    let restartDoneAt = 0
    const perform = vi.fn(async () => { await sleep(120); restartDoneAt = Date.now() })
    const shim = await shimFor(upstream, { restart: { afterNth: 2, match: 'POST /reserve', perform } })

    await send(shim.port, 'POST', '/reserve', 'first')
    expect(perform).not.toHaveBeenCalled()
    const held = await send(shim.port, 'POST', '/reserve', 'second')
    await send(shim.port, 'POST', '/reserve', 'third')

    expect(perform).toHaveBeenCalledTimes(1)
    expect(held.elapsedMs).toBeGreaterThanOrEqual(110)
    expect(upstream.seen.map((r) => r.body)).toEqual(['first', 'second', 'third'])
    expect(upstream.seen[1].at).toBeGreaterThanOrEqual(restartDoneAt)
    expect(shim.events.map((e) => e.kind)).toEqual(['forwarded', 'restarted', 'forwarded', 'forwarded'])
    expect(shim.events[1]).toEqual({ at: expect.any(String), kind: 'restarted', slot: 'api', method: 'POST', path: '/reserve', afterNth: 2 })
  })

  it('does not count a non-matching request', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    const perform = vi.fn(async () => {})
    const shim = await shimFor(upstream, { restart: { afterNth: 1, match: 'WRITE /**', perform } })

    await send(shim.port, 'GET', '/reserve')
    expect(perform).not.toHaveBeenCalled()
    await send(shim.port, 'DELETE', '/reserve/1')
    expect(perform).toHaveBeenCalledTimes(1)
  })

  // The forward that follows tells the truth about the service (a 502 if it
  // never came back), so the failed restart is recorded, not raised.
  it('records a restart that failed and still forwards the held request', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    const shim = await shimFor(upstream, { restart: { afterNth: 1, match: 'POST /x', perform: async () => { throw new Error('health never passed') } } })

    const res = await send(shim.port, 'POST', '/x', 'b')

    expect(res.status).toBe(201)
    expect(upstream.seen).toHaveLength(1)
    expect(shim.events[0]).toEqual({ at: expect.any(String), kind: 'restart-error', slot: 'api', method: 'POST', path: '/x', afterNth: 1, reason: 'health never passed' })
    expect(shim.events[1].kind).toBe('forwarded')
  })

  it('stringifies a non-Error rejection from the restart hook', async () => {
    const upstream = await stubUpstream(); open.push(upstream)
    const shim = await shimFor(upstream, { restart: { afterNth: 1, match: 'POST /x', perform: async () => { throw 'pty gone' } } })

    await send(shim.port, 'POST', '/x', 'b')

    expect(shim.events[0]).toMatchObject({ kind: 'restart-error', reason: 'pty gone' })
  })
})
