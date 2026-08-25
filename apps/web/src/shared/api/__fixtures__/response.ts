// Response builders shared by the per-module api client tests. Lives under
// __fixtures__/ so the coverage config's existing exclude keeps test-only
// infrastructure out of the gate.

export const ok = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export const fail = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
