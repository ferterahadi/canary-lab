import path from 'path'
import fs from 'fs'
import type { FastifyBaseLogger } from 'fastify'
import { NotificationStore } from '../store'
import { flightNotificationSources, testReviewNotificationSources } from '../sources'
import { isCommittedSuiteRetirement } from '../retired-suite'
import { pendingRunReview } from '../../runs/logic/runtime/run-review-gate'
import type { RunStore, RunStoreEvent } from '../../runs/logic/run-store'
import type { DirtySpecStore, DirtySpecStoreEvent } from '../../runs/logic/dirty-specs/store'
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
  const failures = new Set<string>()
  const featureDirs = new Map<string, string>()
  const revisions = new Map<string, number>()
  const checks = new Map<string, Promise<void>>()
  const retirementQueue = new Map<string, number>()
  let refreshing: Promise<void> | undefined
  let refreshError: unknown
  let closed = false
  const keyOf = (feature: string): string => `test-review:${feature}`
  const configExists = (feature: string): boolean => ['cjs', 'js', 'ts'].some((extension) =>
    fs.existsSync(path.join(deps.featuresDir, feature, `feature.config.${extension}`)))
  const scopeOf = (feature: string): Set<string> => new Set([keyOf(feature)])
  const report = (error: unknown): void => {
    deps.log.error({ err: error }, 'Could not update notifications')
  }
  const protect = (work: () => void, scope?: ReadonlySet<string>): void => {
    try { work() } catch (error) {
      // Producer failures must not throw into a run or replace the last inbox.
      report(error)
      try { store.markUnavailable(scope) } catch (storeError) {
        deps.log.error({ err: storeError }, 'Could not mark notification refresh unavailable')
      }
    }
  }
  const syncFlights = (): void => {
    if (closed) return
    const scope = new Set<string>()
    protect(() => {
      for (const key of store.sourceKeys('flight:')) scope.add(key)
      const sources = flightNotificationSources(deps.flightStore.list())
      for (const source of sources) scope.add(source.key)
      // An unavailable assessment is itself an actionable source with an
      // explanation. Reconcile it so even a first read can create the notice.
      store.reconcile(sources, new Set(), scope)
    }, scope)
  }
  const syncTests = (feature?: string): void => {
    if (closed) return
    const scope = feature ? scopeOf(feature) : new Set<string>()
    protect(() => {
      if (!feature) for (const key of store.sourceKeys('test-review:')) scope.add(key)
      if (refreshError) throw refreshError instanceof Error ? refreshError : new Error(String(refreshError))
      const runs = deps.runStore.list().filter((run) => !feature || run.feature === feature)
      const changes = deps.dirtySpecStore.list().filter((change) => !feature || change.featureId === feature)
      const names = new Set([...runs.map((run) => run.feature), ...changes.map((change) => change.featureId),
        ...[...scope].map((key) => key.slice('test-review:'.length))])
      const unavailable = new Set(failures)
      const checking = new Set<string>()
      const sources: NotificationSource[] = []
      for (const name of names) {
        const key = keyOf(name)
        scope.add(key)
        const liveDir = featureDirs.get(name) ?? path.join(deps.featuresDir, name)
        if (!configExists(name) || !fs.existsSync(liveDir)) {
          // Missing live suites have no current review action. This settles the
          // episode, not the historical edits; Git retirement is a separate proof.
          unavailable.delete(key)
          continue
        }
        store.restore(name)
        if (checks.has(name)) checking.add(key)
        try {
          const featureRuns = runs.filter((run) => run.feature === name)
          const review = pendingRunReview({ list: () => featureRuns, get: (id) => deps.runStore.get(id) }, name, liveDir)
          sources.push(...testReviewNotificationSources(featureRuns, changes.filter((change) => change.featureId === name), review ? [review] : []))
        } catch (error) {
          unavailable.add(key)
          deps.log.warn({ err: error, feature: name }, 'Could not refresh test-review notification')
        }
      }
      store.reconcile(sources, unavailable, scope, checking)
    }, scope)
  }
  const sync = (feature?: string): void => { syncFlights(); syncTests(feature) }

  // Only the full audit needs historical retirement evidence. One Git process
  // at a time bounds load; ordinary run events and inbox reads never enqueue it.
  const retireMissing = async (): Promise<void> => {
    for (const [feature, revision] of retirementQueue) {
      if (closed) break
      try {
        const retired = await isCommittedSuiteRetirement(deps.featuresDir, feature)
        if (!closed && retired && revisions.get(feature) === revision && !configExists(feature)) store.retire(feature)
      } catch (error) { report(error) }
      retirementQueue.delete(feature)
    }
  }
  const discover = (): void => {
    const features = loadFeatures(deps.featuresDir)
    featureDirs.clear()
    for (const feature of features) {
      if (typeof feature.featureDir === 'string') featureDirs.set(feature.name, feature.featureDir)
    }
    refreshError = undefined
  }
  const refreshFeature = (feature: string, changed = false): Promise<void> => {
    if (closed) return Promise.resolve()
    if (changed) revisions.set(feature, (revisions.get(feature) ?? 0) + 1)
    const pending = checks.get(feature)
    if (pending) return pending
    const key = keyOf(feature)
    protect(() => store.markUnavailable(scopeOf(feature)), scopeOf(feature))
    // Defer until the slot is installed: recompute can synchronously emit a
    // dirty-store event, whose projection must see the source as unverified.
    const checking = Promise.resolve().then(async () => {
      let revision: number | undefined
      do {
        revision = revisions.get(feature)
        try {
          const dir = featureDirs.get(feature)
          if (dir) await deps.dirtySpecStore.recompute(feature, dir)
          if (revision === revisions.get(feature)) failures.delete(key)
        } catch (error) {
          if (revision === revisions.get(feature)) failures.add(key)
          deps.log.warn({ err: error, feature }, 'Could not refresh test integrity for notifications')
        }
        // A newer file/config event invalidates this check. Rerun immediately;
        // do not reset a debounce timer that a busy suite could starve forever.
      } while (!closed && revision !== revisions.get(feature))
    }).finally(() => {
      checks.delete(feature)
      if (!closed) syncTests(feature)
    })
    checks.set(feature, checking)
    return checking
  }
  const refresh = (): Promise<void> => {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try { discover() } catch (error) { refreshError = error }
      if (!refreshError) {
        for (const feature of [...featureDirs.keys()]) {
          if (closed) return
          await refreshFeature(feature)
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        for (const key of failures) {
          if (!featureDirs.has(key.slice('test-review:'.length))) failures.delete(key)
        }
      }
      if (closed) return
      sync()
      try {
        const historical = new Set([...deps.runStore.list().map((run) => run.feature),
          ...deps.dirtySpecStore.list().map((change) => change.featureId),
          ...store.sourceKeys('test-review:').map((key) => key.slice('test-review:'.length))])
        for (const feature of historical) {
          if (!configExists(feature) && !store.isRetired(feature)) retirementQueue.set(feature, revisions.get(feature) ?? 0)
        }
        // Establish a revision for previously unseen historical suites as well.
        for (const [feature, revision] of retirementQueue) if (!revisions.has(feature)) revisions.set(feature, revision)
        await retireMissing()
      } catch (error) { report(error) }
    })().finally(() => { refreshing = undefined })
    return refreshing
  }
  const recover = (): void => {
    refresh().catch((error) => deps.log.error({ err: error }, 'Could not recover notifications'))
  }
  const refreshChanged = (feature: string): void => {
    try { discover() } catch (error) { refreshError = error; syncTests(feature); return }
    refreshFeature(feature, true).catch((error) => report(error))
  }
  const onRun = (event?: RunStoreEvent): void => {
    if (event?.kind === 'journal-changed') return
    const scope = new Set<string>()
    protect(() => {
      for (const key of store.sourceKeys('test-review:')) scope.add(key)
      const feature = event?.runId ? deps.runStore.list().find((run) => run.runId === event.runId)?.feature : undefined
      syncTests(feature)
    }, scope)
  }
  const onDirty = (event?: DirtySpecStoreEvent): void => { syncTests(event?.featureId) }
  let recoveryTimer: ReturnType<typeof setInterval> | undefined
  let unsubscribeWorkspace: (() => void) | undefined
  const start = (): void => {
    recover()
    sync()
    recoveryTimer = setInterval(recover, NOTIFICATION_RECOVERY_MS)
    recoveryTimer.unref()
    unsubscribeWorkspace = deps.workspaceEvents.subscribe?.((event) => {
      if (event.type === 'feature-deleted') {
        revisions.set(event.feature, (revisions.get(event.feature) ?? 0) + 1)
        featureDirs.delete(event.feature)
        try { store.retire(event.feature); syncTests(event.feature) } catch (error) { deps.log.error({ err: error }, 'Could not retire test-review notification') }
      }
      if (event.type === 'tests-changed' || event.type === 'feature-created') refreshChanged(event.feature)
      if (event.type === 'feature-renamed') { refreshChanged(event.from); refreshChanged(event.to) }
      if (event.type === 'features-changed') {
        for (const feature of new Set([...checks.keys(), ...retirementQueue.keys()])) revisions.set(feature, (revisions.get(feature) ?? 0) + 1)
        try { discover() } catch (error) { refreshError = error }
        recover()
      }
    })
    deps.flightStore.onEvent(syncFlights)
    deps.runStore.onEvent(onRun)
    deps.dirtySpecStore.onEvent(onDirty)
  }
  const dispose = async (): Promise<void> => {
    closed = true
    clearInterval(recoveryTimer)
    unsubscribeWorkspace?.()
    deps.flightStore.offEvent(syncFlights)
    deps.runStore.offEvent(onRun)
    deps.dirtySpecStore.offEvent(onDirty)
    await Promise.all([refreshing, ...checks.values()])
  }
  const refreshAction = async (id: string): Promise<void> => {
    const item = store.list().find((entry) => entry.id === id)
    if (item?.target?.kind === 'flight') { syncFlights(); return }
    if (item?.target?.kind !== 'test-review' || item.resolvedAt) return
    const feature = item.target.feature
    try {
      discover()
      if (!featureDirs.has(feature)) throw new Error('Suite configuration is unavailable')
      await refreshFeature(feature, true)
    } catch (error) {
      failures.add(keyOf(feature))
      deps.log.warn({ err: error, feature }, 'Could not refresh notification action')
    }
  }
  return { store, start, reconcile: sync, refresh, refreshAction, dispose }
}
