/** Command callers own HTTP-status interpretation and transport-failure recovery. */
export async function requestCliJson(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { status: response.status, json }
}
