import type { FastifyInstance } from 'fastify'
import path from 'path'
import fs from 'fs'
import { createHash } from 'crypto'
import type { ServerContext } from '../../server-context'
import { NotificationStore } from './store'
import { flightNotificationSources, testReviewNotificationSources } from './sources'
import { pendingRunReview } from '../runs/logic/runtime/run-review-gate'
import { isCommittedSuiteRetirement } from './retired-suite'
import { loadFeatures } from '../../shared/feature-loader'
import { notificationTarget, type NotificationSource } from '../../../../../shared/notifications/types'

export const NOTIFICATION_RECOVERY_MS = 10_000

export async function register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  const store = new NotificationStore(ctx.logsDir, ctx.workspaceEvents)
  let unavailableSources = new Set<string>()
  const refreshFailures = new Set<string>()
  const featureDirs = new Map<string, string>()
  let refreshError: unknown
  const testSources = (unavailable: Set<string>): NotificationSource[] => {
    const changes = ctx.dirtySpecStore.list()
    const runs = ctx.runStore.list()
    if (refreshError) throw refreshError instanceof Error ? refreshError : new Error(String(refreshError))
    const retired = new Set<string>()
    const missing = new Set<string>()
    const featureNames = new Set([...runs.map((run) => run.feature), ...changes.map((change) => change.featureId)])
    const reviews = [...featureNames].flatMap((feature) => {
      const discoveryDir = path.join(ctx.featuresDir, feature)
      const liveDir = featureDirs.get(feature) ?? discoveryDir
      // Config belongs to the discovery folder; featureDir may point to a
      // linked suite that legitimately contains only tests and helpers.
      const configExists = ['cjs', 'js', 'ts'].some((extension) => fs.existsSync(path.join(discoveryDir, `feature.config.${extension}`)))
      if (!configExists && (store.isRetired(feature) || isCommittedSuiteRetirement(ctx.featuresDir, feature))) {
        store.retire(feature)
        retired.add(feature)
        return []
      }
      if (!configExists || !fs.existsSync(liveDir)) {
        // Historical edits remain evidence, but a missing live suite offers no
        // current review action. Absence settles this episode without approving
        // any bytes; restoring the suite can create a fresh review episode.
        missing.add(feature)
        unavailable.delete(`test-review:${feature}`)
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
    return reviewSources
  }
  const reconcile = (): void => {
    const unavailable = new Set(refreshFailures)
    const sources: NotificationSource[] = []
    for (const [prefix, read] of [
      ['flight:', () => flightNotificationSources(ctx.flightStore.list())],
      ['test-review:', () => testSources(unavailable)],
    ] as const) {
      try { sources.push(...read()) } catch (error) {
        for (const key of store.sourceKeys(prefix)) unavailable.add(key)
        app.log.error({ err: error }, 'Could not update notifications')
      }
    }
    store.reconcile(sources, unavailable)
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
      try { store.markUnavailable() } catch (storeError) {
        app.log.error({ err: storeError }, 'Could not mark notification refresh unavailable')
      }
    }
  }
  let refreshing: Promise<void> | undefined
  let closed = false
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        const features = loadFeatures(ctx.featuresDir)
        featureDirs.clear()
        for (const feature of features) {
          if (typeof feature.featureDir === 'string') featureDirs.set(feature.name, feature.featureDir)
        }
        refreshError = undefined
        for (const [feature, dir] of featureDirs) {
          if (closed) return
          const key = `test-review:${feature}`
          try {
            await ctx.dirtySpecStore.recompute(feature, dir)
            refreshFailures.delete(key)
          } catch (error) {
            refreshFailures.add(key)
            app.log.warn({ err: error, feature }, 'Could not refresh test integrity for notifications')
          }
          // Large workspaces must not monopolize the server during recovery.
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        for (const key of refreshFailures) {
          if (!featureDirs.has(key.slice('test-review:'.length))) refreshFailures.delete(key)
        }
      } catch (error) { refreshError = error }
      if (!closed) sync()
    })().finally(() => { refreshing = undefined })
    return refreshing
  }
  const recover = (): void => {
    refresh().catch((error) => app.log.error({ err: error }, 'Could not recover notifications'))
  }
  recover()
  sync()
  const recoveryTimer = setInterval(recover, NOTIFICATION_RECOVERY_MS)
  recoveryTimer.unref()
  const unsubscribeWorkspace = ctx.workspaceEvents.subscribe?.((event) => {
    if (event.type === 'feature-deleted') {
      try { store.retire(event.feature); sync() } catch (error) { app.log.error({ err: error }, 'Could not retire test-review notification') }
    }
    if (event.type === 'feature-created') sync()
    if (event.type === 'tests-changed' || event.type === 'feature-created' || event.type === 'feature-renamed' || event.type === 'features-changed') recover()
  })
  ctx.flightStore.onEvent(sync)
  ctx.runStore.onEvent(sync)
  ctx.dirtySpecStore.onEvent(sync)
  app.addHook('onClose', async () => {
    closed = true
    clearInterval(recoveryTimer)
    await refreshing
    unsubscribeWorkspace?.()
    ctx.flightStore.offEvent(sync)
    ctx.runStore.offEvent(sync)
    ctx.dirtySpecStore.offEvent(sync)
  })
  app.get<{ Params: { feature: string } }>('/api/notifications/feature/:feature', async (request) => {
    sync()
    const feature = request.params.feature
    const flights = new Set(ctx.flightStore.list().filter((flight) => flight.feature === feature).map((flight) => flight.flightId))
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
  await app.register(notificationRoutes, { store, reconcile: sync, refresh: async (id) => {
    const item = store.list().find((entry) => entry.id === id)
    if (item?.target?.kind !== 'test-review' || item.resolvedAt) return
    const feature = item.target.feature
    try {
      const config = loadFeatures(ctx.featuresDir).find((entry) => entry.name === feature)
      if (typeof config?.featureDir !== 'string') throw new Error('Suite configuration is unavailable')
      featureDirs.set(feature, config.featureDir)
      await ctx.dirtySpecStore.recompute(feature, config.featureDir)
      refreshFailures.delete(`test-review:${feature}`)
    } catch (error) {
      refreshFailures.add(`test-review:${feature}`)
      app.log.warn({ err: error, feature }, 'Could not refresh notification action')
    }
  } })
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
