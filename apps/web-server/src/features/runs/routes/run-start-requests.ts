import type { FastifyInstance } from 'fastify'
import type { RunsRouteDeps } from './runs-route-deps'
import { RunStartRequests } from '../logic/run-start-requests'

/** The browser observes internal continuations. Only the original external
 * session may consume an external request, through the MCP transport. */
export function registerRunStartRequests(app: FastifyInstance, deps: RunsRouteDeps): RunStartRequests {
  const requests = new RunStartRequests(deps.store, deps.workspaceEvents)
  const dispatch = async (payload: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload })
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> }
  }
  app.get<{ Params: { requestId: string } }>('/api/run-requests/:requestId', async (req, reply) => {
    const request = requests.get(req.params.requestId)
    return request ?? reply.code(404).send({ error: 'Run request not found' })
  })
  for (const action of ['resume', 'cancel'] as const) {
    app.post<{ Params: { requestId: string }; Body?: { sessionId?: string } }>(`/api/run-requests/:requestId/${action}`, async (req, reply) => {
      const request = requests.get(req.params.requestId)
      if (!request) return reply.code(404).send({ error: 'Run request not found' })
      if (!requests.owns(request, req.body?.sessionId, req.headers['x-canary-origin'] === 'mcp')) {
        return reply.code(409).send({ error: 'Continue this request in the client that started it.', request })
      }
      if (action === 'cancel') return requests.cancel(request.requestId)
      const response = await requests.resume(request.requestId, dispatch)
      return reply.code(response.statusCode).send(response.body)
    })
  }
  let closed = false
  const reconcile = () => {
    if (closed) return
    for (const request of requests.list()) {
      if (request.owner.kind !== 'internal' || !['awaiting-review', 'ready'].includes(request.status)) continue
      const current = requests.get(request.requestId)
      if (current?.status === 'ready') void requests.resume(current.requestId, dispatch).catch((error) => app.log.error(error))
    }
  }
  // Persistence is authoritative; the run event is only the fast path. The
  // bounded read also recovers a missed receipt event and server reconnect.
  const onRunEvent = () => { queueMicrotask(reconcile) }
  deps.store.onEvent(onRunEvent)
  const timer = setInterval(reconcile, 5000)
  timer.unref()
  app.addHook('onReady', async () => {
    requests.reconcileInterrupted()
    setTimeout(reconcile, 0).unref()
  })
  app.addHook('onClose', async () => {
    closed = true
    clearInterval(timer)
    deps.store.offEvent(onRunEvent)
    requests.dispose()
  })
  return requests
}
