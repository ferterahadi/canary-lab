import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../../server-context'
import { createNotificationRuntime } from './logic/notification-runtime'
import { notificationRoutes, registerFeatureNotificationRoute } from './routes/notifications'

export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const flights = ctx.flightAttention ?? ctx.flightStore
  const runtime = createNotificationRuntime({
    logsDir: ctx.logsDir,
    featuresDir: ctx.featuresDir,
    runStore: ctx.runStore,
    flightStore: flights,
    dirtySpecStore: ctx.dirtySpecStore,
    workspaceEvents: ctx.workspaceEvents,
    log: app.log,
  })
  runtime.start()
  app.addHook('onClose', runtime.dispose)
  registerFeatureNotificationRoute(app, {
    store: runtime.store, reconcile: runtime.reconcile, listFlights: () => flights.list(),
  })
  await app.register(notificationRoutes, { store: runtime.store, reconcile: runtime.reconcile, refresh: runtime.refreshAction })
}
