import {
  FileBackedTaskStore,
  type TaskStoreEvent,
} from '../../../../../../../shared/lib/file-backed-task-store'
import {
  computeDirty,
  hashFeatureSpecs,
  hashFeatureSpecTests,
  promoteGreen,
  type DirtySpec,
  type SpecHashes,
} from './detect'

// Feature-scoped, file-backed store of test-file integrity ("dirty") state. One
// record per feature, the single source of truth both the UI and the MCP run
// result read. Wraps the shared FileBackedTaskStore (atomic writes, index,
// change events) and owns the dirty-specific baselines + recompute/approve/
// finalize transitions. Layout: <logs>/dirty-specs/<feature>/dirty.json.

export const DIRTY_MESSAGE = '⚠️ Tests have been modified, please review.'

export interface DirtySpecRecord {
  id: string
  featureId: string
  createdAt: string
  status: 'clean' | 'dirty'
  dirtySpecs: DirtySpec[]
  lastGreenHashes: SpecHashes
  runStartHashes: SpecHashes
  approvedHashes: SpecHashes
  /** Per-test counterparts (see `detect.ts`'s `testHashKey`) — narrows `affectedTests`
   *  to the test(s) actually edited instead of every test in a touched file. */
  lastGreenTestHashes: SpecHashes
  runStartTestHashes: SpecHashes
  approvedTestHashes: SpecHashes
  message: string
  /** When the current status was entered (ISO). */
  since: string
}

export interface DirtySpecStoreEvent {
  kind: 'changed' | 'removed'
  featureId?: string
}

function emptyRecord(featureId: string, now: string): DirtySpecRecord {
  return {
    id: featureId,
    featureId,
    createdAt: now,
    status: 'clean',
    dirtySpecs: [],
    lastGreenHashes: {},
    runStartHashes: {},
    approvedHashes: {},
    lastGreenTestHashes: {},
    runStartTestHashes: {},
    approvedTestHashes: {},
    message: DIRTY_MESSAGE,
    since: now,
  }
}

export class DirtySpecStore {
  private readonly listeners = new Set<(event: DirtySpecStoreEvent) => void>()
  private readonly store: FileBackedTaskStore<DirtySpecRecord>

  constructor(logsDir: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.store = new FileBackedTaskStore<DirtySpecRecord>({
      logsDir,
      dirName: 'dirty-specs',
      recordFile: 'dirty.json',
      idOf: (r) => r.featureId,
      indexEntryOf: (r) => ({
        id: r.featureId,
        createdAt: r.createdAt,
        featureId: r.featureId,
        status: r.status,
        since: r.since,
      }),
    })
    this.store.onEvent((e: TaskStoreEvent) => this.emit({ kind: e.kind, featureId: e.id }))
  }

  get(featureId: string): DirtySpecRecord | null {
    return this.store.get(featureId)
  }

  /** Whether the feature currently has modified specs — the flag both surfaces read. */
  isDirty(featureId: string): boolean {
    return this.get(featureId)?.status === 'dirty'
  }

  private load(featureId: string): DirtySpecRecord {
    return this.get(featureId) ?? emptyRecord(featureId, this.now())
  }

  private saveWithDirty(rec: DirtySpecRecord, status: 'clean' | 'dirty', dirtySpecs: DirtySpec[]): DirtySpecRecord {
    const changed = status !== rec.status
    const next: DirtySpecRecord = {
      ...rec,
      status,
      dirtySpecs,
      message: DIRTY_MESSAGE,
      since: changed ? this.now() : rec.since,
    }
    this.store.save(next)
    return next
  }

  // Re-derive dirty status from the working tree at `featureDir` against the
  // stored baselines. The one operation every trigger funnels through: the
  // fs.watch debounce, a git commit, run finalize, and approve all end here.
  async recompute(featureId: string, featureDir: string): Promise<DirtySpecRecord> {
    const rec = this.load(featureId)
    const { status, dirtySpecs } = await computeDirty(featureDir, rec)
    return this.saveWithDirty(rec, status, dirtySpecs)
  }

  // Capture the pre-heal baseline at run start. Used as the fallback baseline
  // when the feature has no green yet; never itself a green attestation.
  async captureRunStart(featureId: string, featureDir: string): Promise<DirtySpecRecord> {
    const rec = this.load(featureId)
    const runStartHashes = hashFeatureSpecs(featureDir)
    const runStartTestHashes = hashFeatureSpecTests(featureDir)
    const withStart: DirtySpecRecord = { ...rec, runStartHashes, runStartTestHashes }
    const { status, dirtySpecs } = await computeDirty(featureDir, withStart)
    return this.saveWithDirty(withStart, status, dirtySpecs)
  }

  // Finalize a run. On a pass, promote the green baseline for specs untouched
  // since run start (a tampered-but-passing spec is NOT promoted). Failed/aborted
  // runs leave the green baseline alone — they only recompute the live status.
  async finalizeRun(featureId: string, featureDir: string, passed: boolean): Promise<DirtySpecRecord> {
    const rec = this.load(featureId)
    let base = rec
    if (passed) {
      const verdictHashes = hashFeatureSpecs(featureDir)
      const verdictTestHashes = hashFeatureSpecTests(featureDir)
      base = {
        ...rec,
        lastGreenHashes: promoteGreen(rec.runStartHashes, verdictHashes, rec.lastGreenHashes),
        lastGreenTestHashes: promoteGreen(
          rec.runStartTestHashes ?? {},
          verdictTestHashes,
          rec.lastGreenTestHashes ?? {},
        ),
      }
    }
    const { status, dirtySpecs } = await computeDirty(featureDir, base)
    return this.saveWithDirty(base, status, dirtySpecs)
  }

  // User accepts the current spec content as intended (Canary-local). Records the
  // current hashes as approved so the cue clears without a commit.
  async approve(featureId: string, featureDir: string): Promise<DirtySpecRecord> {
    const rec = this.load(featureId)
    const approvedHashes = { ...rec.approvedHashes, ...hashFeatureSpecs(featureDir) }
    const approvedTestHashes = { ...rec.approvedTestHashes, ...hashFeatureSpecTests(featureDir) }
    const withApproved: DirtySpecRecord = { ...rec, approvedHashes, approvedTestHashes }
    const { status, dirtySpecs } = await computeDirty(featureDir, withApproved)
    return this.saveWithDirty(withApproved, status, dirtySpecs)
  }

  remove(featureId: string): void {
    this.store.remove(featureId)
  }

  onEvent(fn: (event: DirtySpecStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: DirtySpecStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: DirtySpecStoreEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        /* a bad listener must not break persistence */
      }
    }
  }
}
