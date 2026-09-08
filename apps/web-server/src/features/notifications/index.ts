import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../../server-context'
import { NotificationStore } from './store'
import { flightNotificationSources, runNotificationSources } from './sources'

export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const store = new NotificationStore(ctx.logsDir, ctx.workspaceEvents)
  const sync = (): void => {
    try {
      store.reconcile([...flightNotificationSources(ctx.flightStore.list()), ...runNotificationSources(ctx.runStore.list())])
    } catch (error) {
      // Inbox persistence must not interrupt the run whose event triggered it.
      // GET also fails visibly so a corrupt inbox is not presented as empty.
      app.log.error({ err: error }, 'Could not update notifications')
    }
  }
  sync()
  ctx.flightStore.onEvent(sync)
  ctx.runStore.onEvent(sync)
  app.addHook('onClose', async () => {
    ctx.flightStore.offEvent(sync)
    ctx.runStore.offEvent(sync)
  })
  await app.register(notificationRoutes, { store })
}

export async function notificationRoutes(app: FastifyInstance, { store }: { store: NotificationStore }): Promise<void> {
  app.get('/api/notifications', async () => store.list())
  app.post<{ Body: { title: string; body?: string } }>('/api/notifications', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['title'], properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', maxLength: 2000 },
    } } },
  }, async (request, reply) => {
    if (!request.body.title.trim()) return reply.code(400).send({ error: 'Enter a notification title' })
    return reply.code(201).send(store.add(request.body.title.trim(), request.body.body?.trim() ?? ''))
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
