// Shared fetch core for the per-domain API modules in this directory.
// `request` and `defaultOpts` are internal to shared/api — client.ts does not
// re-export them, so the public API surface is unchanged by the split.


export class ApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export type FetchLike = typeof fetch

export interface ClientOptions {
  baseUrl?: string
  fetchImpl?: FetchLike
  /** Local invalidation generation; never sent over HTTP. */
  readRevision?: string
}

export const defaultOpts = (opts?: ClientOptions): Required<Pick<ClientOptions, 'baseUrl' | 'fetchImpl'>> => ({
  baseUrl: opts?.baseUrl ?? '',
  fetchImpl: opts?.fetchImpl ?? globalThis.fetch.bind(globalThis),
})

const snapshotReads = new WeakMap<FetchLike, Map<string, Promise<unknown>>>()

/** Coalesce concurrent readers, not results. A newer invalidation must start a
 * new request instead of inheriting an older in-flight response. */
export function requestSnapshot<T>(pathname: string, opts?: ClientOptions): Promise<T> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  // defaultOpts binds fetch per call; use the underlying function as identity.
  const identity = opts?.fetchImpl ?? globalThis.fetch
  let pending = snapshotReads.get(identity)
  if (!pending) { pending = new Map(); snapshotReads.set(identity, pending) }
  const key = JSON.stringify([baseUrl, pathname, opts?.readRevision])
  const existing = pending.get(key)
  if (existing) return existing as Promise<T>
  const promise = request<T>(`${baseUrl}${pathname}`, { method: 'GET' }, fetchImpl)
    .finally(() => { pending.delete(key) })
  pending.set(key, promise)
  return promise
}

export async function request<T>(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<T> {
  const res = await fetchImpl(url, init)
  const text = await res.text()
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    // Surface the server's `{ error }` message (most routes return one) as the
    // Error message so callers showing `e.message` get the real reason, not a
    // bare "HTTP 409".
    const message =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : undefined
    throw new ApiError(res.status, body, message)
  }
  return body as T
}
