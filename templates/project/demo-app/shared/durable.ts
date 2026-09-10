import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

// What lets these services survive the two things a robustness envelope does
// to them by default — a restart and a replayed write — without the suite
// noticing either.
//
// Durability: a service's whole state is one JSON file, rewritten synchronously
// as each write is answered and read back on boot, so a SIGTERM between two
// requests loses nothing. The file lives under the service's working directory
// (`.state/`, ignored by git). Canary Lab runs each service in its own per-run
// worktree of this repo, so two runs never share a file.
//
// Idempotency: a write that carries an `Idempotency-Key` header is applied
// once. A second request with the same key gets the first response back,
// byte for byte, and changes nothing. The storefront suite sends a fresh key
// on every write; a client that sends none is applied every time it asks.

export interface Reply {
  status: number
  body: string
}

export interface Durable<T> {
  state: T
  save(): void
}

export interface Replayable {
  replies: Record<string, Reply>
}

export function openStore<T extends Replayable>(service: string, initial: () => T): Durable<T> {
  const dir = path.resolve(process.env.STOREFRONT_STATE_DIR ?? '.state')
  const file = path.join(dir, `${service}.json`)
  const state: T = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : initial()
  return {
    state,
    save() {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(state))
    },
  }
}

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Call first for every request. Returns true when the request was answered
 *  from the idempotency log — the handler must not run. Otherwise the response
 *  is wrapped so that, as it ends, the state is saved and a keyed write's reply
 *  is logged under its key. Reads change nothing and are left alone. */
export function durableRequest(store: Durable<Replayable>, req: IncomingMessage, res: ServerResponse): boolean {
  if (READ_ONLY.has(req.method ?? 'GET')) return false
  const header = req.headers['idempotency-key']
  const key = Array.isArray(header) ? header[0] : header
  const seen = key ? store.state.replies[key] : undefined
  if (seen) {
    res.writeHead(seen.status, { 'Content-Type': 'application/json', 'Idempotent-Replayed': 'true' })
    res.end(seen.body)
    return true
  }
  const end = res.end.bind(res)
  res.end = ((chunk?: unknown) => {
    if (key) store.state.replies[key] = { status: res.statusCode, body: typeof chunk === 'string' ? chunk : '' }
    store.save()
    return end(typeof chunk === 'string' ? chunk : undefined)
  }) as typeof res.end
  return false
}
