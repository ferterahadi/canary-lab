import path from 'path'
import fs from 'fs'
import type { FastifyBaseLogger } from 'fastify'
import { NotificationStore } from '../store'
import { flightNotificationSources, testReviewNotificationSources } from '../sources'
import { isCommittedSuiteRetirement } from '../retired-suite'
import { pendingRunReview } from '../../runs/logic/runtime/run-review-gate'
import type { RunStore } from '../../runs/logic/run-store'
import type { DirtySpecStore } from '../../runs/logic/dirty-specs/store'
import type { FlightRunStore } from '../../flights/logic/store'
import { loadFeatures } from '../../../shared/feature-loader'
import type { WorkspaceEventBus, WorkspaceEventPublisher } from '../../../shared/workspace-events'
import type { NotificationSource } from '../../../../../../shared/notifications/types'

export const NOTIFICATION_RECOVERY_MS = 10_000

interface NotificationRuntimeDeps {
  logsDir: string
  featuresDir: string
  runStore: Pick<RunStore, 'list' | 'get' | 'onEvent' | 'offEvent'>
  flightStore: Pick<FlightRunStore, 'list' | 'onEvent' | 'offEvent'>
  dirtySpecStore: Pick<DirtySpecStore, 'list' | 'recompute' | 'onEvent' | 'offEvent'>
  workspaceEvents: WorkspaceEventPublisher & Partial<Pick<WorkspaceEventBus, 'subscribe'>>
  log: Pick<FastifyBaseLogger, 'warn' | 'error'>
}

export function createNotificationRuntime(deps: NotificationRuntimeDeps) {
  const store = new NotificationStore(deps.logsDir, deps.workspaceEvents)
  let unavailableSources = new Set<string>()
  const refreshFailures = new Set<string>()
  const featureDirs = new Map<string, string>()
  let refreshError: unknown
  const testSources = (unavailable: Set<string>): NotificationSource[] => {
    const changes = deps.dirtySpecStore.list()
    const runs = deps.runStore.list()
    if (refreshError) throw refreshError instanceof Error ? refreshError : new Error(String(refreshError))
    const retired = new Set<string>()
    const missing = new Set<string>()
    const featureNames = new Set([...runs.map((run) => run.feature), ...changes.map((change) => change.featureId)])
    const reviews = [...featureNames].flatMap((feature) => {
      const discoveryDir = path.join(deps.featuresDir, feature)
      const liveDir = featureDirs.get(feature) ?? discoveryDir
      // Config belongs to the discovery folder; featureDir may point to a
      // linked suite that legitimately contains only tests and helpers.
      const configExists = ['cjs', 'js', 'ts'].some((extension) => fs.existsSync(path.join(discoveryDir, `feature.config.${extension}`)))
      if (!configExists && (store.isRetired(feature) || isCommittedSuiteRetirement(deps.featuresDir, feature))) {
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
        const review = pendingRunReview(deps.runStore, feature, liveDir)
        return review ? [review] : []
      } catch (error) {
        // Historical artifacts can be removed independently of the inbox.
        // An unreadable comparison is not evidence that its review settled.
        const key = `test-review:${feature}`
        unavailable.add(key)
        if (!unavailableSources.has(key)) deps.log.warn({ err: error, feature }, 'Could not refresh test-review notification')
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
      ['flight:', () => flightNotificationSources(deps.flightStore.list())],
      ['test-review:', () => testSources(unavailable)],
    ] as const) {
      try { sources.push(...read()) } catch (error) {
        for (const key of store.sourceKeys(prefix)) unavailable.add(key)
        deps.log.error({ err: error }, 'Could not update notifications')
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
      deps.log.error({ err: error }, 'Could not update notifications')
      try { store.markUnavailable() } catch (storeError) {
        deps.log.error({ err: storeError }, 'Could not mark notification refresh unavailable')
      }
    }
  }
  let refreshing: Promise<void> | undefined
  let closed = false
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        const features = loadFeatures(deps.featuresDir)
        featureDirs.clear()
        for (const feature of features) {
          if (typeof feature.featureDir === 'string') featureDirs.set(feature.name, feature.featureDir)
        }
        refreshError = undefined
        for (const [feature, dir] of featureDirs) {
          if (closed) return
          const key = `test-review:${feature}`
          try {
            await deps.dirtySpecStore.recompute(feature, dir)
            refreshFailures.delete(key)
          } catch (error) {
            refreshFailures.add(key)
            deps.log.warn({ err: error, feature }, 'Could not refresh test integrity for notifications')
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
    refresh().catch((error) => deps.log.error({ err: error }, 'Could not recover notifications'))
  }
  let recoveryTimer: ReturnType<typeof setInterval> | undefined
  let unsubscribeWorkspace: (() => void) | undefined
  // Registration starts this once, before installing the HTTP routes.
  const start = (): void => {
    recover()
    sync()
    recoveryTimer = setInterval(recover, NOTIFICATION_RECOVERY_MS)
    recoveryTimer.unref()
    unsubscribeWorkspace = deps.workspaceEvents.subscribe?.((event) => {
      if (event.type === 'feature-deleted') {
        try { store.retire(event.feature); sync() } catch (error) { deps.log.error({ err: error }, 'Could not retire test-review notification') }
      }
      if (event.type === 'feature-created') sync()
      if (event.type === 'tests-changed' || event.type === 'feature-created' || event.type === 'feature-renamed' || event.type === 'features-changed') recover()
    })
    deps.flightStore.onEvent(sync)
    deps.runStore.onEvent(sync)
    deps.dirtySpecStore.onEvent(sync)
  }
  const dispose = async (): Promise<void> => {
    closed = true
    clearInterval(recoveryTimer)
    await refreshing
    unsubscribeWorkspace?.()
    deps.flightStore.offEvent(sync)
    deps.runStore.offEvent(sync)
    deps.dirtySpecStore.offEvent(sync)
  }
  const refreshAction = async (id: string): Promise<void> => {
    const item = store.list().find((entry) => entry.id === id)
    if (item?.target?.kind !== 'test-review' || item.resolvedAt) return
    const feature = item.target.feature
    try {
      const config = loadFeatures(deps.featuresDir).find((entry) => entry.name === feature)
      if (typeof config?.featureDir !== 'string') throw new Error('Suite configuration is unavailable')
      featureDirs.set(feature, config.featureDir)
      await deps.dirtySpecStore.recompute(feature, config.featureDir)
      refreshFailures.delete(`test-review:${feature}`)
    } catch (error) {
      refreshFailures.add(`test-review:${feature}`)
      deps.log.warn({ err: error, feature }, 'Could not refresh notification action')
    }
  }
  return { store, start, reconcile: sync, refreshAction, dispose }
}
