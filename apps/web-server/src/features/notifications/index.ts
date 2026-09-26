import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../../server-context'
import { createNotificationRuntime } from './logic/notification-runtime'
import { notificationRoutes, registerFeatureNotificationRoute } from './routes/notifications'

export { NOTIFICATION_RECOVERY_MS } from './logic/notification-runtime'
export { notificationRoutes } from './routes/notifications'

export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const runtime = createNotificationRuntime({
    logsDir: ctx.logsDir,
    featuresDir: ctx.featuresDir,
    runStore: ctx.runStore,
    flightStore: ctx.flightStore,
    dirtySpecStore: ctx.dirtySpecStore,
    workspaceEvents: ctx.workspaceEvents,
    log: app.log,
  })
  runtime.start()
  app.addHook('onClose', runtime.dispose)
  registerFeatureNotificationRoute(app, {
    store: runtime.store, reconcile: runtime.reconcile, listFlights: () => ctx.flightStore.list(),
  })
  await app.register(notificationRoutes, { store: runtime.store, reconcile: runtime.reconcile, refresh: runtime.refreshAction })
}
