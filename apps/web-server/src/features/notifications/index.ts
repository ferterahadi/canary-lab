import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../../server-context'
import { NotificationStore } from './store'
import { flightNotificationSources, runNotificationSources, testChangeNotificationSources } from './sources'

export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const store = new NotificationStore(ctx.logsDir, ctx.workspaceEvents)
  let changes = ctx.dirtySpecStore.list()
  const sync = (): void => {
    try {
      const runs = ctx.runStore.list()
      store.reconcile([
        ...flightNotificationSources(ctx.flightStore.list()),
        ...runNotificationSources(runs, changes),
        ...testChangeNotificationSources(changes, runs),
      ])
    } catch (error) {
      // Inbox persistence must not interrupt the run whose event triggered it.
      // GET also fails visibly so a corrupt inbox is not presented as empty.
      app.log.error({ err: error }, 'Could not update notifications')
    }
  }
  const syncChanges = (): void => { changes = ctx.dirtySpecStore.list(); sync() }
  sync()
  ctx.flightStore.onEvent(sync)
  ctx.runStore.onEvent(sync)
  ctx.dirtySpecStore.onEvent(syncChanges)
  app.addHook('onClose', async () => {
    ctx.flightStore.offEvent(sync)
    ctx.runStore.offEvent(sync)
    ctx.dirtySpecStore.offEvent(syncChanges)
  })
  await app.register(notificationRoutes, { store })
}

export async function notificationRoutes(app: FastifyInstance, { store }: { store: NotificationStore }): Promise<void> {
  app.get('/api/notifications', async () => store.list())
  app.delete<{ Params: { id: string } }>('/api/notifications/:id', async (request, reply) => {
    store.remove(request.params.id)
    return reply.code(204).send()
  })
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (request, reply) => {
    store.markRead(request.params.id)
    return reply.code(204).send()
  })
}
