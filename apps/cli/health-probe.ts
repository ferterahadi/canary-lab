/** Callers retain timeout, decoding strictness, and server-identity policies. */
export async function probeCliHealth(
  url: string | URL,
  options: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    decode: 'none' | 'optional' | 'required'
  },
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const response = options.signal
    ? await fetchImpl(url, { signal: options.signal })
    : await fetchImpl(url)
  let body: unknown
  if (response.ok && options.decode !== 'none') {
    body = options.decode === 'optional'
      ? await response.json().catch(() => null)
      : await response.json()
  }
  return { ok: response.ok, status: response.status, body }
}
