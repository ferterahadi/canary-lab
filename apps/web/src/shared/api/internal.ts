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
}

export const defaultOpts = (opts?: ClientOptions): Required<ClientOptions> => ({
  baseUrl: opts?.baseUrl ?? '',
  fetchImpl: opts?.fetchImpl ?? globalThis.fetch.bind(globalThis),
})

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

