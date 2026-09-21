import type { FastifyInstance } from 'fastify'
import path from 'path'
import type { ServerContext } from '../../server-context'
import { NotificationStore } from './store'
import { flightNotificationSources, testReviewNotificationSources } from './sources'
import { pendingRunReview } from '../runs/logic/runtime/run-review-gate'

export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const store = new NotificationStore(ctx.logsDir, ctx.workspaceEvents)
  let unavailableSources = new Set<string>()
  const reconcile = (): void => {
    const changes = ctx.dirtySpecStore.list()
    const runs = ctx.runStore.list()
    const unavailable = new Set<string>()
    const reviews = [...new Set(runs.map((run) => run.feature))].flatMap((feature) => {
      try {
        const review = pendingRunReview(ctx.runStore, feature, path.join(ctx.featuresDir, feature))
        return review ? [review] : []
      } catch (error) {
        // Historical artifacts can be removed independently of the inbox.
        // An unreadable comparison is not evidence that its review settled.
        const key = `test-review:${feature}`
        unavailable.add(key)
        if (!unavailableSources.has(key)) app.log.warn({ err: error, feature }, 'Could not refresh test-review notification')
        return []
      }
    })
    store.reconcile([
      ...flightNotificationSources(ctx.flightStore.list()),
      ...testReviewNotificationSources(runs, changes, reviews),
    ], unavailable)
    unavailableSources = unavailable
  }
  const sync = (): void => {
    try {
      reconcile()
    } catch (error) {
      // A failed producer refresh must neither interrupt its run nor discard
      // the last good inbox. GET still reads the inbox itself outside this
      // boundary, so a corrupt database fails visibly instead of looking empty.
      app.log.error({ err: error }, 'Could not update notifications')
    }
  }
  sync()
  ctx.flightStore.onEvent(sync)
  ctx.runStore.onEvent(sync)
  ctx.dirtySpecStore.onEvent(sync)
  app.addHook('onClose', async () => {
    ctx.flightStore.offEvent(sync)
    ctx.runStore.offEvent(sync)
    ctx.dirtySpecStore.offEvent(sync)
  })
  await app.register(notificationRoutes, { store, reconcile: sync })
}

export async function notificationRoutes(app: FastifyInstance, { store, reconcile }: { store: NotificationStore; reconcile?: () => void }): Promise<void> {
  // The inbox's bounded read also repairs a missed filesystem/store event.
  app.get('/api/notifications', async () => { reconcile?.(); return store.list() })
  app.delete<{ Params: { id: string } }>('/api/notifications/:id', async (request, reply) => {
    store.remove(request.params.id)
    return reply.code(204).send()
  })
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (request, reply) => {
    store.markRead(request.params.id)
    return reply.code(204).send()
  })
}
