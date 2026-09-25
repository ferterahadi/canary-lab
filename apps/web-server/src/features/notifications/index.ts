import type { FastifyInstance } from 'fastify'
import path from 'path'
import fs from 'fs'
import type { ServerContext } from '../../server-context'
import { NotificationStore } from './store'
import { flightNotificationSources, testReviewNotificationSources } from './sources'
import { pendingRunReview } from '../runs/logic/runtime/run-review-gate'
import { isCommittedSuiteRetirement } from './retired-suite'

export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const store = new NotificationStore(ctx.logsDir, ctx.workspaceEvents)
  let unavailableSources = new Set<string>()
  const reconcile = (): void => {
    const changes = ctx.dirtySpecStore.list()
    const runs = ctx.runStore.list()
    const unavailable = new Set<string>()
    const retired = new Set<string>()
    const missing = new Set<string>()
    const featureNames = new Set([...runs.map((run) => run.feature), ...changes.map((change) => change.featureId)])
    const reviews = [...featureNames].flatMap((feature) => {
      const liveDir = path.join(ctx.featuresDir, feature)
      const configExists = fs.existsSync(path.join(liveDir, 'feature.config.cjs'))
      if (!configExists && (store.isRetired(feature) || isCommittedSuiteRetirement(ctx.featuresDir, feature))) {
        store.retire(feature)
        retired.add(feature)
        return []
      }
      const latest = runs.find((run) => run.feature === feature)
      const snapshot = !configExists && latest ? ctx.runStore.get(latest.runId)?.manifest.suiteSnapshot : undefined
      if (!fs.existsSync(liveDir) || (!configExists && snapshot?.kind === 'taken' && fs.existsSync(path.join(snapshot.dir, 'feature.config.cjs')))) {
        if (snapshot?.kind === 'taken') missing.add(feature)
        return []
      }
      store.restore(feature)
      try {
        const review = pendingRunReview(ctx.runStore, feature, liveDir)
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
    const reviewSources = testReviewNotificationSources(runs.filter((run) => !retired.has(run.feature)), changes.filter((change) => !retired.has(change.featureId)), reviews)
      .filter((source) => !missing.has(source.key.slice('test-review:'.length)))
    const missingSources = [...missing].map((feature) => {
      const run = runs.find((entry) => entry.feature === feature)
      return { key: `test-review:${feature}`, signature: 'attention', message: {
        title: `${feature}: suite unavailable`,
        body: 'The live suite folder is missing. Restore it to review test changes; the saved run remains available.',
        severity: 'warning' as const, toast: false,
        target: { kind: 'test-review' as const, feature, ...(run ? { runId: run.runId } : {}) },
      } }
    })
    store.reconcile([
      ...flightNotificationSources(ctx.flightStore.list()),
      ...reviewSources, ...missingSources,
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
  const unsubscribeWorkspace = ctx.workspaceEvents.subscribe?.((event) => {
    if (event.type === 'feature-deleted') {
      try { store.retire(event.feature); sync() } catch (error) { app.log.error({ err: error }, 'Could not retire test-review notification') }
    }
    if (event.type === 'feature-created') sync()
  })
  ctx.flightStore.onEvent(sync)
  ctx.runStore.onEvent(sync)
  ctx.dirtySpecStore.onEvent(sync)
  app.addHook('onClose', async () => {
    unsubscribeWorkspace?.()
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
