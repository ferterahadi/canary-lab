import fs from 'fs'
import path from 'path'
import { COVERAGE_RECONCILE_MS, type FeatureCoverageChange } from '../../../../../../../shared/coverage/freshness'
import type { CoverageLedger } from '../../../../../../../shared/coverage/types'
import type { WorkspaceEventBus } from '../../../../shared/workspace-events'
import { coverageRevision } from './freshness'
import { docsDirFor } from './docs-collection'
import { CoverageSnapshotCache } from './snapshot-cache'

/** One process-owned observer backs the UI, inbox, and agent waits. Filesystem
 * events are hints; content reconciliation also follows links and catches
 * changes made while the process or a socket was disconnected. */
export class CoverageFreshnessMonitor {
  private readonly values = new Map<string, FeatureCoverageChange>()
  private readonly listeners = new Set<(change: FeatureCoverageChange) => void>()
  private readonly watchers = new Map<string, fs.FSWatcher>()
  private readonly waiting = new Set<() => void>()
  private timer?: ReturnType<typeof setInterval>
  private pending?: ReturnType<typeof setTimeout>
  private unsubscribe?: () => void
  private closed = false
  private scanning = false
  private readonly snapshots: CoverageSnapshotCache

  constructor(
    private readonly paths: { featuresDir: string; logsDir: string },
    private readonly events: WorkspaceEventBus,
    private readonly warn: (error: unknown) => void,
  ) { this.snapshots = new CoverageSnapshotCache(paths) }

  ledger(feature: string): CoverageLedger {
    const ledger = this.snapshots.get(feature)
    this.observe(ledger)
    return ledger
  }

  read(feature: string, featureDir?: string, context?: ReturnType<CoverageSnapshotCache['context']>): FeatureCoverageChange {
    let change: FeatureCoverageChange
    try {
      const ledger = this.snapshots.get(feature, featureDir, context)
      change = this.observe(ledger)
    } catch (error) {
      change = { feature, delivery: 'tool-response-and-wait', freshness: {
        revision: coverageRevision(String(error)), checkedAt: new Date().toISOString(),
        state: 'unavailable', reasons: ['Cannot confirm coverage freshness: ' + (error instanceof Error ? error.message : String(error))],
        changedTests: [], latestRunFailed: false, proofNeedsRun: false,
      } }
      this.accept(change)
    }
    return change
  }

  observe(ledger: CoverageLedger): FeatureCoverageChange {
    const change: FeatureCoverageChange = { feature: ledger.feature, freshness: ledger.freshness!, delivery: 'tool-response-and-wait',
      measurement: { coveragePct: ledger.coveragePct, covered: ledger.totals.covered, total: ledger.totals.total, tests: ledger.tests.length } }
    this.accept(change)
    return change
  }

  private accept(change: FeatureCoverageChange): void {
    const previous = this.values.get(change.feature)
    this.values.set(change.feature, change)
    if (previous?.freshness.revision === change.freshness.revision) return
    for (const listener of this.listeners) listener(change)
    this.events.publish({ type: 'coverage-changed', feature: change.feature, revision: change.freshness.revision })
  }

  list(): FeatureCoverageChange[] { return [...this.values.values()] }

  readAll(): FeatureCoverageChange[] {
    const context = this.snapshots.context()
    return this.snapshots.features().map((feature) => this.read(feature.name, feature.featureDir, context))
  }

  schedule(): void {
    if (this.closed || this.pending) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      void this.reconcile().catch(this.warn)
    }, 150)
    this.pending.unref()
  }

  async reconcile(): Promise<void> {
    if (this.closed || this.scanning) return
    this.scanning = true
    try {
      // A directory can appear after startup, or its watcher can fail. Retry
      // attachment during reconciliation instead of losing fast updates forever.
      this.watch(this.paths.featuresDir, true)
      this.watch(this.paths.logsDir, true)
      const features = this.snapshots.features()
      const context = this.snapshots.context()
      const present = new Set(features.map((feature) => feature.name))
      for (const feature of this.values.keys()) if (!present.has(feature)) {
        this.values.delete(feature)
        this.snapshots.remove(feature)
        this.events.publish({ type: 'coverage-changed', feature })
      }
      for (const feature of features) {
        if (this.closed) break
        this.read(feature.name, feature.featureDir, context)
        if (feature.featureDir) this.watchLinkedDocs(feature.featureDir)
        // Large workspaces must not monopolize the event loop between suites.
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } finally { this.scanning = false }
  }

  private watch(dir: string, recursive: boolean): void {
    if (this.watchers.has(dir) || !fs.existsSync(dir)) return
    try {
      this.watchers.set(dir, fs.watch(dir, { recursive }, (_event, name) => {
        if (name && /(^|[/\\])(node_modules|\.git|test-results|playwright-report)([/\\]|$)/.test(String(name))) return
        if (dir === this.paths.logsDir && name && !/(e2e-summary|manifest|index)\.json$/.test(String(name))) return
        this.schedule()
      }).on('error', (error) => {
        this.watchers.get(dir)?.close()
        this.watchers.delete(dir)
        this.warn(error)
        this.schedule()
      }))
    } catch (error) { this.warn(error) /* content reconciliation remains the recovery path */ }
  }

  private watchLinkedDocs(featureDir: string): void {
    const dir = docsDirFor(featureDir)
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      try {
        if (fs.lstatSync(file).isSymbolicLink()) this.watch(path.dirname(path.resolve(dir, fs.readlinkSync(file))), false)
      } catch { /* A concurrent rename is recovered by the next content scan. */ }
    }
  }

  start(): void {
    this.watch(this.paths.featuresDir, true)
    this.watch(this.paths.logsDir, true)
    this.unsubscribe = this.events.subscribe((event) => {
      if (event.type === 'coverage-changed' && event.revision === this.values.get(event.feature)?.freshness.revision) return
      if (['coverage-changed', 'tests-changed', 'tests-dirty-changed', 'features-changed', 'feature-created', 'feature-deleted', 'feature-renamed'].includes(event.type)) this.schedule()
    })
    this.timer = setInterval(() => { void this.reconcile().catch(this.warn) }, COVERAGE_RECONCILE_MS)
    this.timer.unref()
    this.schedule()
  }

  async wait(feature: string, afterRevision: string | undefined, timeoutMs: number): Promise<{ changed: boolean; change: FeatureCoverageChange }> {
    const first = this.read(feature)
    if (!afterRevision || first.freshness.revision !== afterRevision || timeoutMs <= 0) return { changed: first.freshness.revision !== afterRevision, change: first }
    return new Promise((resolve) => {
      let settled = false
      const finish = (change: FeatureCoverageChange): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.listeners.delete(listener)
        this.waiting.delete(cancel)
        resolve({ changed: change.freshness.revision !== afterRevision, change })
      }
      const cancel = (): void => finish({ ...first, freshness: { ...first.freshness, state: 'unavailable', reasons: ['Server is shutting down; reconnect to confirm freshness.'] } })
      const listener = (change: FeatureCoverageChange): void => {
        if (change.feature === feature && change.freshness.revision !== afterRevision) finish(change)
      }
      const timer = setTimeout(() => finish(this.read(feature)), Math.min(timeoutMs, 30_000))
      timer.unref()
      this.listeners.add(listener)
      this.waiting.add(cancel)
      const current = this.read(feature)
      if (current.freshness.revision !== afterRevision) finish(current)
    })
  }

  close(): void {
    this.closed = true
    clearInterval(this.timer)
    clearTimeout(this.pending)
    this.unsubscribe?.()
    for (const cancel of this.waiting) cancel()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.snapshots.clear()
  }
}
