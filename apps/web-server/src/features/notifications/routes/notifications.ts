import type { FastifyInstance } from 'fastify'
import { createHash } from 'crypto'
import type { NotificationStore } from '../store'
import type { FlightRunStore } from '../../flights/logic/store'
import { notificationTarget } from '../../../../../../shared/notifications/types'

export function registerFeatureNotificationRoute(app: FastifyInstance, { store, reconcile, listFlights }: {
  store: NotificationStore
  reconcile: () => void
  listFlights: FlightRunStore['list']
}): void {
  app.get<{ Params: { feature: string } }>('/api/notifications/feature/:feature', async (request) => {
    reconcile()
    const feature = request.params.feature
    const flights = new Set(listFlights().filter((flight) => flight.feature === feature).map((flight) => flight.flightId))
    const relevant = store.list().filter((item) => item.target?.kind === 'flight'
      ? flights.has(item.target.flightId) : item.target && 'feature' in item.target && item.target.feature === feature)
    // Keep agent context bounded while retaining recent settlements so a missed
    // push or reconnect does not leave an agent acting on an obsolete review.
    const attention = relevant.filter((item) => !item.resolvedAt)
    const items = [...attention.slice(0, 20), ...relevant.filter((item) => item.resolvedAt).slice(0, 5)]
      .map((item) => ({ id: item.id, title: item.title, state: item.unavailable ? 'unavailable' : item.resolvedAt ? 'resolved' : 'attention', action: notificationTarget(item) }))
    return { feature, revision: createHash('sha256').update(JSON.stringify({ items, attentionCount: attention.length })).digest('hex'), items,
      attentionCount: attention.length, omittedAttentionCount: Math.max(0, attention.length - 20),
      delivery: 'tool-response-and-wait', guidance: 'Use current actions. Resolved notifications require no review; unavailable state is not resolution. A notification does not authorize unrelated work.' }
  })
}

export async function notificationRoutes(app: FastifyInstance, { store, reconcile, refresh }: { store: NotificationStore; reconcile?: () => void; refresh?: (id: string) => Promise<void> }): Promise<void> {
  // The inbox's bounded read also repairs a missed filesystem/store event.
  app.get('/api/notifications', async () => { reconcile?.(); return store.list() })
  app.post<{ Params: { id: string } }>('/api/notifications/:id/resolve-action', async (request) => {
    await refresh?.(request.params.id)
    reconcile?.()
    const items = store.list()
    const item = items.find((entry) => entry.id === request.params.id)
    if (!item) return { items, status: 'missing' }
    if (item.unavailable) return { items, status: 'unavailable' }
    return { items, status: 'current', target: notificationTarget(item) }
  })
  app.delete<{ Params: { id: string } }>('/api/notifications/:id', async (request, reply) => {
    store.remove(request.params.id)
    return reply.code(204).send()
  })
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (request, reply) => {
    store.markRead(request.params.id)
    return reply.code(204).send()
  })
}
