import http from 'http'
import type { AddressInfo } from 'net'
import { compileRequestMatch } from '../../../../../../../../shared/robustness/request-match'
import type { DuplicateAtom, LatencyAtom, RestartAtom } from '../../../../../../../../shared/robustness/types'

// The perturbation shim (D14): one HTTP/1.1 reverse proxy per declared port
// slot. The service keeps its real port; Playwright and the envsets are handed
// the shim's, so no app source changes. Every atom is deterministic — shrink
// (D16) bisects the knobs, and a perturbation that only sometimes fires would
// make the search meaningless.
//
// Request bodies are buffered rather than streamed because the duplicate atom
// replays them byte-for-byte; suites here move kilobytes, not uploads.
// Responses stream through after the latency hold.

export type ProxyShimEvent =
  | { at: string; kind: 'forwarded'; slot: string; method: string; path: string; delayedMs?: number }
  | { at: string; kind: 'duplicated'; slot: string; method: string; path: string; gapMs: number }
  | { at: string; kind: 'duplicate-error'; slot: string; method: string; path: string; reason: string }
  | { at: string; kind: 'upstream-error'; slot: string; method: string; path: string; reason: string }
  | { at: string; kind: 'upgrade-refused'; slot: string; method: string; path: string }
  | { at: string; kind: 'restarted'; slot: string; method: string; path: string; afterNth: number }
  | { at: string; kind: 'restart-error'; slot: string; method: string; path: string; afterNth: number; reason: string }

export interface StartProxyShimOptions {
  slot: string
  upstreamPort: number
  /** 0 lets the OS pick; production passes a port from the allocator so the
   *  `${port.<slot>}` token and `CANARY_PORT_<slot>` resolve to it. */
  listenPort: number
  upstreamHost?: string
  latency?: LatencyAtom
  duplicate?: DuplicateAtom
  /** The shim owns WHEN (the Nth match); the caller owns HOW the slot's service
   *  is recycled — see `restart-slot.ts`. Fires once per shim. */
  restart?: Pick<RestartAtom, 'afterNth' | 'match'> & { perform: () => Promise<void> }
  onEvent?: (event: ProxyShimEvent) => void
}

export interface ProxyShim {
  slot: string
  port: number
  upstreamPort: number
  /** Everything the shim did, in order — the trace a finding is built from. */
  events: readonly ProxyShimEvent[]
  /** Re-arm the once-per-shim restart so the next Playwright pass meets the
   *  same perturbation the first one did. Latency and duplicate are stateless. */
  reset: () => void
  close: () => Promise<void>
}

// Hop-by-hop headers describe THIS connection; re-sending them to the upstream
// would either be refused or describe the wrong hop. Content-length is re-set
// from the buffered body.
const DROP_REQUEST_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'proxy-connection', 'upgrade'])

export async function startProxyShim(opts: StartProxyShimOptions): Promise<ProxyShim> {
  const upstreamHost = opts.upstreamHost ?? '127.0.0.1'
  const events: ProxyShimEvent[] = []
  const timers = new Set<NodeJS.Timeout>()
  const inflight = new Set<http.ClientRequest>()
  const duplicate = opts.duplicate ? { ...opts.duplicate, matches: compileRequestMatch(opts.duplicate.match) } : undefined
  const restart = opts.restart ? { ...opts.restart, matches: compileRequestMatch(opts.restart.match) } : undefined
  let restartMatchCount = 0
  let restartFired = false
  const record = (event: ProxyShimEvent) => {
    events.push(event)
    opts.onEvent?.(event)
  }
  const base = (method: string, path: string) => ({ at: new Date().toISOString(), slot: opts.slot, method, path })

  const forward = (method: string, path: string, headers: http.OutgoingHttpHeaders, body: Buffer, onResponse: (res: http.IncomingMessage) => void, onError: (err: Error) => void) => {
    const req = http.request({ host: upstreamHost, port: opts.upstreamPort, method, path, headers: { ...headers, 'content-length': body.length } }, (res) => {
      inflight.delete(req)
      onResponse(res)
    })
    inflight.add(req)
    req.on('error', (err) => {
      inflight.delete(req)
      onError(err)
    })
    req.end(body)
  }

  const server = http.createServer((clientReq, clientRes) => {
    const { method, path } = requestLine(clientReq)
    const chunks: Buffer[] = []
    clientReq.on('data', (c: Buffer) => chunks.push(c))
    clientReq.on('end', async () => {
      const body = Buffer.concat(chunks)
      const headers: http.OutgoingHttpHeaders = {}
      for (const [k, v] of Object.entries(clientReq.headers)) if (!DROP_REQUEST_HEADERS.has(k)) headers[k] = v

      // Hold the Nth match while the service is recycled; forwarding it
      // afterwards is what makes lost in-memory state observable to the test.
      if (restart && restart.matches(method, path) && !restartFired && ++restartMatchCount === restart.afterNth) {
        restartFired = true
        const { afterNth } = restart
        try {
          await restart.perform()
          record({ ...base(method, path), kind: 'restarted', afterNth })
        } catch (err) {
          record({ ...base(method, path), kind: 'restart-error', afterNth, reason: err instanceof Error ? err.message : String(err) })
        }
      }

      forward(method, path, headers, body, (upstreamRes) => {
        const respond = () => {
          clientRes.writeHead(upstreamRes.statusCode as number, upstreamRes.headers)
          upstreamRes.pipe(clientRes)
        }
        const delayedMs = opts.latency?.ms
        if (delayedMs === undefined) {
          record({ ...base(method, path), kind: 'forwarded' })
          respond()
        } else {
          record({ ...base(method, path), kind: 'forwarded', delayedMs })
          const t = setTimeout(() => { timers.delete(t); respond() }, delayedMs)
          timers.add(t)
        }
      }, (err) => {
        const reason = `upstream ${upstreamHost}:${opts.upstreamPort} unreachable: ${err.message}`
        record({ ...base(method, path), kind: 'upstream-error', reason })
        clientRes.writeHead(502, { 'content-type': 'text/plain' })
        clientRes.end(`canary-lab perturbation shim (${opts.slot}): ${reason}\n`)
      })

      if (duplicate && duplicate.matches(method, path)) {
        const { gapMs } = duplicate
        const t = setTimeout(() => {
          timers.delete(t)
          record({ ...base(method, path), kind: 'duplicated', gapMs })
          forward(method, path, headers, body, (res) => { res.resume() }, (err) => {
            record({ ...base(method, path), kind: 'duplicate-error', reason: err.message })
          })
        }, gapMs)
        timers.add(t)
      }
    })
  })

  server.on('upgrade', (req, socket) => {
    const { method, path } = requestLine(req)
    record({ ...base(method, path), kind: 'upgrade-refused' })
    // Destroy after the refusal flushes: an upgraded socket leaves the server's
    // connection tracking, so a client that never reads would otherwise hold
    // `close()` open forever.
    socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\ncanary-lab perturbation shim: WebSocket upgrades are not proxied in v1\r\n', () => socket.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.listenPort, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port

  return {
    slot: opts.slot,
    port,
    upstreamPort: opts.upstreamPort,
    events,
    reset: () => { restartMatchCount = 0; restartFired = false },
    close: () => new Promise<void>((resolve) => {
      for (const t of timers) clearTimeout(t)
      timers.clear()
      for (const req of inflight) req.destroy()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

/** A server-side IncomingMessage always carries its request line; the type
 *  leaves `method`/`url` optional only because the same class doubles as a
 *  client response (where `statusCode` is the one always set). Casting keeps
 *  the invariant in one place instead of four dead `??` fallbacks. */
function requestLine(req: http.IncomingMessage): { method: string; path: string } {
  return { method: req.method as string, path: req.url as string }
}
